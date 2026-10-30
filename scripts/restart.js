// Stops the running service (after verifying it is the one holding the lock)
// and runs the new one in this process. `pelican restart` does the same in
// the background.
import { stopService } from "../src/service.js";

try {
  await stopService({ log: console.log });
  await import("../src/main.js");
} catch (error) {
  console.error(
    `Pelican restart could not complete: ${error.message}. No second service was started.`,
  );
  process.exitCode = 1;
}
