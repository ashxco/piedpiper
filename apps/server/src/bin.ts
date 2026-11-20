import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@piedpiper/shared/Net";
import { cli } from "./cli";
import { ignoreMacosTypeOfServiceEinval } from "./macosTypeOfService";
import { ignoreOutputStreamError } from "./launcherWatch";
import { keepOutboundFetchOnHttp1 } from "./outboundHttp";
import { version } from "../package.json" with { type: "json" };

// Logs go to stdout and stderr, which may be a closed desktop launcher pipe or a log file on a
// full disk. Node emits a failed write as an unhandled stream error that crashes the process and
// skips shutdown (leaving the ownership lock and runtime record behind), so drop the line instead.
process.stdout.on("error", ignoreOutputStreamError);
process.stderr.on("error", ignoreOutputStreamError);

// Guard sockets before anything can open an outbound connection.
ignoreMacosTypeOfServiceEinval();
keepOutboundFetchOnHttp1();

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

Command.run(cli, { version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
  NodeRuntime.runMain,
);
