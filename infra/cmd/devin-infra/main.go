package main

import (
	"context"
	"log"
	"os"

	"github.com/rshdhere/devin/infra/internal/cli"
)

func main() {
	log.SetFlags(0)
	if err := cli.Run(context.Background(), os.Args[1:]); err != nil {
		log.Printf("error: %v", err)
		os.Exit(1)
	}
}
