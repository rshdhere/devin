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

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"

	devinv1 "github.com/rshdhere/devin/packages/sandbox/api/v1"
	"github.com/rshdhere/devin/apps/orchestrator/internal/server"
	"github.com/rshdhere/devin/packages/orchestrator/config"
	"github.com/rshdhere/devin/packages/orchestrator/reconcile"
	"github.com/rshdhere/devin/packages/orchestrator/store"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(devinv1.AddToScheme(scheme))
}

func main() {
	cfg := config.LoadFromEnv()
	port := envInt("ORCHESTRATOR_PORT", 9090)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var sandboxStore store.SandboxStore
	var hostStore store.HostStore

	if cfg.DryRun {
		slog.Info("orchestrator running in dry-run mode", "namespace", cfg.SandboxNamespace)
		sandboxStore = store.NewMemoryStore(cfg)
	} else {
		restConfig := ctrl.GetConfigOrDie()
		mgr, err := ctrl.NewManager(restConfig, ctrl.Options{
			Scheme: scheme,
		})
		if err != nil {
			slog.Error("failed to create controller manager", "error", err)
			os.Exit(1)
		}

		if cfg.ControllerEnabled {
			if err := (&reconcile.SandboxReconciler{
				Client: mgr.GetClient(),
				Scheme: mgr.GetScheme(),
				Config: cfg,
			}).SetupWithManager(mgr); err != nil {
				slog.Error("failed to register sandbox controller", "error", err)
				os.Exit(1)
			}
			if err := (&reconcile.FirecrackerMachineReconciler{
				Client: mgr.GetClient(),
				Scheme: mgr.GetScheme(),
				Config: cfg,
			}).SetupWithManager(mgr); err != nil {
				slog.Error("failed to register firecracker machine controller", "error", err)
				os.Exit(1)
			}
			if err := (&reconcile.FirecrackerHostReconciler{
				Client: mgr.GetClient(),
				Config: cfg,
			}).SetupWithManager(mgr); err != nil {
				slog.Error("failed to register firecracker host controller", "error", err)
				os.Exit(1)
			}
			if err := (&reconcile.NodePoolReconciler{
				Client: mgr.GetClient(),
				Config: cfg,
			}).SetupWithManager(mgr); err != nil {
				slog.Error("failed to register node pool controller", "error", err)
				os.Exit(1)
			}
		}

		go func() {
			if err := mgr.Start(ctx); err != nil {
				slog.Error("controller manager stopped", "error", err)
				os.Exit(1)
			}
		}()

		sandboxStore = store.NewKubernetesStore(mgr.GetClient(), cfg.SandboxNamespace)
		hostStore = store.NewKubernetesHostStore(mgr.GetClient(), cfg.FirecrackerNamespace)
		reconcile.StartExternalHostBootstrap(ctx, hostStore, cfg)
		slog.Info("orchestrator connected to kubernetes", "namespace", cfg.SandboxNamespace)
	}

	httpServer := server.NewInternal(sandboxStore, hostStore, cfg.SandboxNamespace)
	addr := ":" + strconv.Itoa(port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           httpServer.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("orchestrator listening", "addr", addr, "dryRun", cfg.DryRun)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("orchestrator server failed", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("orchestrator shutdown failed", "error", err)
		os.Exit(1)
	}
}

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}
