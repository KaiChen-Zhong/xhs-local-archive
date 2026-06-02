"use strict";

const { spawnSync } = require("node:child_process");

const files = [
  "scripts/install-native-host.sh",
  "scripts/verify-native-host.sh",
  "scripts/uninstall-native-host.sh"
];

const result = spawnSync("sh", ["-n", ...files], { stdio: "inherit" });
if (result.error && result.error.code === "ENOENT") {
  console.log("Shell syntax check skipped: sh is not installed on this system.");
  process.exit(0);
}
if (result.error) throw result.error;
process.exit(result.status || 0);
