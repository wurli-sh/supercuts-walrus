#!/usr/bin/env node
import { assertSupportedNode } from "./node-guard.js";

assertSupportedNode();
await import("./demo-main.js");
