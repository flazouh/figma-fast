// Command figma-fast-holder holds the Figma app with --remote-debugging-pipe and relays its CDP pipe
// on a unix socket, for many clients at once.
//
// Settings: FIGMA_HOLDER_APP (the app binary), FIGMACLI_DESKTOP_SOCKET (the socket path).
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/flazouh/figma-fast/holder"
)

func main() {
	cfg := holder.Config{App: os.Getenv("FIGMA_HOLDER_APP"), Socket: os.Getenv("FIGMACLI_DESKTOP_SOCKET"), Log: os.Stdout}
	if cfg.App == "" {
		cfg.App = holder.DefaultApp
	}
	if cfg.Socket == "" {
		cfg.Socket = holder.DefaultSocket()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := holder.Run(ctx, cfg)
	if errors.Is(err, context.Canceled) {
		_ = os.Remove(cfg.Socket)
		return
	}
	fmt.Fprintln(os.Stderr, "figma-fast-holder:", err)
	os.Exit(1)
}
