import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { DevboxToolsClient } from "./types.js";

const PROTO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../proto/devbox/v1/tools.proto",
);

export function createDevboxToolsClient(
  target = process.env.TOOL_GATEWAY_GRPC_URL?.trim() || "127.0.0.1:9095",
): DevboxToolsClient {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as {
    devbox: {
      v1: {
        DevboxTools: {
          new (addr: string, creds: grpc.ChannelCredentials): DevboxToolsClient;
        };
      };
    };
  };
  const addr = target.replace(/^grpc:\/\//, "").replace(/^http:\/\//, "");
  return new proto.devbox.v1.DevboxTools(
    addr,
    grpc.credentials.createInsecure(),
  );
}
