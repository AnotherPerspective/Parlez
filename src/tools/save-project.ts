import { z } from "zod";

import { toolConfirmDenial } from "../confirm-policy.js";
import { errorResult } from "../errors.js";
import { jsxVal } from "../registry.js";
import { defineTool, toMcpResult } from "./define-tool.js";

export const saveProjectTool = defineTool({
  name: "ae_save_project",
  title: "Save project",
  description:
    "Save the project. Pass `path` for Save As. Requires confirm: true — it overwrites the file on disk.",
  group: "document",
  // Overwrites the .aep on disk — not undoable with Ctrl+Z.
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    path: z
      .string()
      .optional()
      .describe(
        "Optional absolute path to save the project to (Save As). If omitted, save to the existing path — " +
          "errors if the project has never been saved.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Must be true: saving overwrites the .aep on disk (and a Save As target that already exists), which Ctrl+Z cannot undo. Set it only when the user asked to save.",
      ),
  },
  handler: async (args, transport) => {
    // Parlez! M3.2: an overwrite of the project file needs the user's yes.
    if (args.confirm !== true) {
      const denial = toolConfirmDenial(
        "ae_save_project",
        "sovrascrive il file del progetto su disco (con path, anche un file che esiste già), e Ctrl+Z non lo annulla",
      );
      return errorResult("FORBIDDEN", denial.message, {
        details: { tool: "ae_save_project", confirmRequired: true },
        hint: denial.hint,
      });
    }
    const code = `
        var _path = ${jsxVal(args.path ?? null)};
        if (_path) {
            var f = new File(_path);
            app.project.save(f);
            return { ok: true, saved: true, path: f.fsName.replace(/\\\\/g, "/") };
        }
        if (!app.project.file) {
            return { ok: false, saved: false, error: "project has no existing path; pass 'path' to save as" };
        }
        app.project.save();
        return { ok: true, saved: true, path: app.project.file.fsName.replace(/\\\\/g, "/") };
    `;
    const result = await transport.execute({ code, label: "save_project" });
    return toMcpResult(result);
  },
});
