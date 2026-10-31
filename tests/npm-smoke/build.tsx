import { buildScriptFiles } from "@tinyenterprise/hono-tools/build";
import "./app.tsx";

await buildScriptFiles();
process.exit(0);
