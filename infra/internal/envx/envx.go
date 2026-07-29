package envx

import "os"

const DefaultRegion = "ap-south-1"

func Env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func Region(arg string) string {
	if arg != "" {
		return arg
	}
	return Env("AWS_REGION", DefaultRegion)
}

func Prefix() string {
	return Env("DEVIN_SSM_PREFIX", "/"+Env("DEVIN_NAME_PREFIX", "devin-production")+"/platform")
}
