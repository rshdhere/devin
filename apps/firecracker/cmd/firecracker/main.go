package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/rshdhere/devin/apps/firecracker/internal/config"
	"github.com/rshdhere/devin/apps/firecracker/internal/pool"
	"github.com/rshdhere/devin/apps/firecracker/internal/server"
)

func main() {
	cfg := config.LoadFromEnv()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	manager, err := pool.NewManager(cfg)
	if err != nil {
		slog.Error("failed to initialize firecracker pool", "error", err)
		os.Exit(1)
	}
	manager.Start(ctx)

	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           server.New(manager).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("firecracker listening",
			"addr", srv.Addr,
			"dryRun", cfg.DryRun,
			"host", cfg.HostName,
			"snapshotDir", cfg.SnapshotDir,
		)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("firecracker failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("firecracker shutdown failed", "error", err)
		os.Exit(1)
	}
}
