// Re-export for jsxImportSource resolution during JSR publish.
// Deno's JSX transform appends "/jsx-runtime" to the jsxImportSource specifier,
// and JSR requires explicit .ts extensions for relative imports.
export * from "../jsx-runtime.ts";
