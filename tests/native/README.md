# Native Fusion Python diagnostic

`FmcadNativeProbe` is a Fusion Python script with a manifest. Link it through
Scripts and Add-Ins and run it explicitly. It records document identity and
output-stream diagnostics under its own `reports/` folder. It does not change
the model, replace output streams or install a startup add-in.

Generated results and developer-specific debugger settings are not included
in the source repository. A successful diagnostic run alone does not prove
visible MCP output or a clean Fusion interpreter.
