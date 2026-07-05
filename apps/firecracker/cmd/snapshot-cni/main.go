package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/rshdhere/devin/apps/firecracker/internal/cnihelper"
)

type output struct {
	TapDevice   string `json:"tapDevice"`
	GuestIP     string `json:"guestIP"`
	MacAddr     string `json:"macAddr"`
	NetNS       string `json:"netns"`
	ContainerID string `json:"containerId"`
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "add":
		if len(os.Args) < 4 {
			usage()
			os.Exit(1)
		}
		if err := runAdd(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "del":
		if len(os.Args) < 4 {
			usage()
			os.Exit(1)
		}
		if err := runDel(os.Args[2], os.Args[3]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		usage()
		os.Exit(1)
	}
}

func runAdd(network, containerID string) error {
	net, err := cnihelper.Add(context.Background(), containerID, cnihelper.Config{
		NetworkName: network,
		ConfDir:     env("FIRECRACKER_CNI_CONF_DIR", "/etc/cni/conf.d"),
		BinPath:     env("FIRECRACKER_CNI_BIN_PATH", "/opt/cni/bin"),
		GuestIP:     os.Getenv("SNAPSHOT_GUEST_IP"),
	})
	if err != nil {
		return err
	}

	payload := output{
		TapDevice:   net.TapDevice,
		MacAddr:     net.MacAddr,
		NetNS:       net.NetNS,
		ContainerID: containerID,
	}
	if net.GuestIP != nil {
		payload.GuestIP = net.GuestIP.String()
	}
	return json.NewEncoder(os.Stdout).Encode(payload)
}

func runDel(network, containerID string) error {
	return cnihelper.Delete(context.Background(), containerID, cnihelper.Config{
		NetworkName: network,
		ConfDir:     env("FIRECRACKER_CNI_CONF_DIR", "/etc/cni/conf.d"),
		BinPath:     env("FIRECRACKER_CNI_BIN_PATH", "/opt/cni/bin"),
	})
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  snapshot-cni add <network> <container-id>")
	fmt.Fprintln(os.Stderr, "  snapshot-cni del <network> <container-id>")
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
