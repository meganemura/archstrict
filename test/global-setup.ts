// Responsibility: build distributable JavaScript before the test suite.
// Boundary: suite setup only; test cases remain in their own files.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  execFileSync("npm", ["run", "build"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
}
