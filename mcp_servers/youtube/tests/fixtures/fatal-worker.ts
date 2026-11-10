import { start } from "../../src/index.ts";

await start();
setTimeout(() => {
  throw new Error("private-cookie-and-account");
}, 0);
