#!/usr/bin/env node
import { assertSupportedNode } from "./node-guard.js";

assertSupportedNode();
await import("./cli-main.js");
