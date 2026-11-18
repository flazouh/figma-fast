package holder

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// DefaultApp is the Figma app binary on a Mac.
const DefaultApp = "/Applications/Figma.app/Contents/MacOS/Figma"

// DefaultSocket is where the holder listens when FIGMACLI_DESKTOP_SOCKET is unset.
func DefaultSocket() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache", "figma-cdp", "cdp.sock")
}

// Config says which app to hold and where to listen.
type Config struct {
	App    string
	Socket string
	// Log takes one line per event: the app's pid, the socket, the pipe closing.
	Log io.Writer
}

// ErrPipeClosed means the app closed its CDP pipe, as it does when it quits.
var ErrPipeClosed = errors.New("app pipe closed")

// keptEnv is all of the holder's environment the app sees.
var keptEnv = []string{"HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "SHELL"}

// clientQueue is how many messages may wait for one slow client before the holder drops it.
const clientQueue = 4096

func (c Config) logf(format string, args ...any) {
	if c.Log != nil {
		fmt.Fprintf(c.Log, time.Now().Format("15:04:05")+" "+format+"\n", args...)
	}
}

// Launch starts the app with --remote-debugging-pipe. The app reads calls on its fd 3 and writes
// replies and events on its fd 4; Launch returns the holder's ends of both pipes.
func Launch(app string) (*exec.Cmd, *os.File, *os.File, error) {
	toAppR, toAppW, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	fromAppR, fromAppW, err := os.Pipe()
	if err != nil {
		toAppR.Close()
		toAppW.Close()
		return nil, nil, nil, err
	}
	cmd := exec.Command(app, "--remote-debugging-pipe")
	// ExtraFiles[i] is the child's fd 3+i.
	cmd.ExtraFiles = []*os.File{toAppR, fromAppW}
	for _, name := range keptEnv {
		if value, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+value)
		}
	}
	if cmd.Env == nil {
		cmd.Env = []string{}
	}
	startErr := cmd.Start()
	toAppR.Close()
	fromAppW.Close()
	if startErr != nil {
		toAppW.Close()
		fromAppR.Close()
		return nil, nil, nil, startErr
	}
	return cmd, toAppW, fromAppR, nil
}

// Run holds the app and serves clients until the app closes its pipe or ctx ends. When ctx ends it
// kills the app it started.
func Run(ctx context.Context, cfg Config) error {
	cmd, toApp, fromApp, err := Launch(cfg.App)
	if err != nil {
		return fmt.Errorf("cannot start %s: %w", cfg.App, err)
	}
	defer toApp.Close()
	defer fromApp.Close()
	go func() { _ = cmd.Wait() }()
	cfg.logf("figma pid %d", cmd.Process.Pid)

	var writeMu sync.Mutex
	router := NewRouter(func(m Message) {
		data, err := json.Marshal(m)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = toApp.Write(append(data, 0))
	})

	if err := os.MkdirAll(filepath.Dir(cfg.Socket), 0o700); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	_ = os.Remove(cfg.Socket)
	listener, err := net.Listen("unix", cfg.Socket)
	if err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	defer listener.Close()
	if err := os.Chmod(cfg.Socket, 0o600); err != nil {
		_ = cmd.Process.Kill()
		return err
	}
	cfg.logf("listening %s", cfg.Socket)

	pumpDone := make(chan error, 1)
	go func() { pumpDone <- pump(fromApp, router) }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serve(conn, router)
		}
	}()

	select {
	case err := <-pumpDone:
		cfg.logf("app pipe closed")
		return err
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		return ctx.Err()
	}
}

// pump reads the app's NUL-ended messages and hands each to the clients the router names.
func pump(fromApp io.Reader, router *Router) error {
	reader := bufio.NewReaderSize(fromApp, 1<<16)
	for {
		raw, err := reader.ReadBytes(0)
		if len(raw) > 0 && raw[len(raw)-1] == 0 {
			var m Message
			if json.Unmarshal(raw[:len(raw)-1], &m) == nil {
				for _, d := range router.FromApp(m) {
					d.Client.Send(d.Message)
				}
			}
		}
		if err != nil {
			return ErrPipeClosed
		}
	}
}

// conn is one client on the socket. Its writer runs on its own, so a slow client never holds up
// the pump and the others; one that falls clientQueue messages behind is dropped.
type conn struct {
	c    net.Conn
	out  chan []byte
	done chan struct{}
	once sync.Once
}

func (c *conn) Send(m Message) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	select {
	case <-c.done:
	case c.out <- append(data, '\n'):
	default:
		c.close()
	}
}

func (c *conn) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.c.Close()
	})
}

func (c *conn) write() {
	for {
		select {
		case <-c.done:
			return
		case data := <-c.out:
			if _, err := c.c.Write(data); err != nil {
				c.close()
				return
			}
		}
	}
}

func serve(nc net.Conn, router *Router) {
	client := &conn{c: nc, out: make(chan []byte, clientQueue), done: make(chan struct{})}
	router.Join(client)
	go client.write()
	defer func() {
		router.Leave(client)
		client.close()
	}()
	reader := bufio.NewReaderSize(nc, 1<<16)
	for {
		line, err := reader.ReadBytes('\n')
		if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
			var m Message
			if json.Unmarshal(trimmed, &m) == nil {
				router.FromClient(client, m)
			}
		}
		if err != nil {
			return
		}
	}
}
