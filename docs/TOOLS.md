# Tool reference

Generated from `src/tools/**` via `npm run docs:tools` — do not edit by hand. For a grouped summary and example prompts, see the main [README](../README.md).

`ae_do`'s operation registry (`layer.*`, `keyframe.*`, …) is discoverable at runtime via `ae_catalog` and is **not** listed in this file.

37 tools across 5 groups.

## Inspect

Read-only project/comp/layer introspection.

| Tool              | Description                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae_project_info` | Project-level info: file path, dirty flag, all items with type/summary, active item.                                                                        |
| `ae_comp_info`    | Detailed comp info: size, fps, duration, work area, motion blur, layer summaries.                                                                           |
| `ae_layer_info`   | Full layer info: transform, effects, masks, text, shape contents, keyframes (incl.                                                                          |
| `ae_version_info` | AE version, build, capabilities (saveFrameToPng, app.effects, Socket).                                                                                      |
| `ae_context`      | Ambient context: project state, active comp, selected layers, item list, AE.* helpers, ES3 rules, and the undo contract (every call = one auto undo group). |

## Document

Save, JSON export, and JSON import of the whole project.

| Tool                     | Description                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ae_save_project`        | Save the project.                                                                                                                  |
| `ae_project_export_json` | Serialize the entire project to JSON (folders, comps, layers, keyframes, effects, shapes, markers, time remap, solids, file refs). |
| `ae_project_import_json` | Rebuild the project from JSON (produced by ae_project_export_json).                                                                |

## Render

Single-frame rendering for visual verification.

| Tool              | Description                       |
| ----------------- | --------------------------------- |
| `ae_render_frame` | Render one or more frames to PNG. |

## Operations

Atomic operation dispatch — discover with `ae_catalog`, execute with `ae_do`.

| Tool         | Description                                            |
| ------------ | ------------------------------------------------------ |
| `ae_catalog` | Discover available atomic operations for ae_do.        |
| `ae_do`      | Execute an atomic operation by name (from ae_catalog). |

## Premiere Pro

Adobe® Premiere Pro® through the Parlez! panel (read-only for now).

| Tool                    | Description                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr_context`            | Premiere Pro: is it connected, which project is open, are the panel's switches on (ON/OFF, Sola lettura), and the rules for working in Premiere.                                                                                                                                                                                                                                                    |
| `pr_project_info`       | Premiere Pro project overview: name and file, every bin and item (clips, sequences, bins) with the bin it sits in, which media are offline, and every sequence with size, fps and duration.                                                                                                                                                                                                         |
| `pr_sequence_info`      | One Premiere Pro sequence in detail: settings (size, fps, duration), playhead and in/out points, every video and audio track with its clips (name, start/end on the timeline, in/out in the source, source item), and the sequence markers (name, comment, start/end, colour).                                                                                                                      |
| `pr_project_check`      | Check a Premiere Pro project the way an editor does before delivery, without changing anything: offline media, clips not used in any sequence, gaps between clips on the video tracks and clips switched off (in one sequence, default the active one, or every sequence), and sequences whose frame size or frame rate differ from the most common one.                                            |
| `pr_frame`              | Render one frame of a Premiere Pro sequence (default the active one) at `time` seconds as a PNG and show it, so you can see the cut.                                                                                                                                                                                                                                                                |
| `pr_markers`            | Add, change or remove markers on a Premiere Pro sequence (default: the active one), in one request.                                                                                                                                                                                                                                                                                                 |
| `pr_bins`               | Organise the Premiere Pro project panel: create bins (paths like "Girato/Interviste", missing levels are created) and move items (clips, sequences, bins - by nodeId from pr_project_info) into a bin, which is created when missing.                                                                                                                                                               |
| `pr_rename_items`       | Rename Premiere Pro project items (clips, bins, sequences - by nodeId from pr_project_info) and/or set their colour label (0-15, Premiere's label order).                                                                                                                                                                                                                                           |
| `pr_sequence_create`    | Create a new Premiere Pro sequence from project clips (nodeIds from pr_project_info), placed one after the other in the order given; the sequence takes its settings from the first clip.                                                                                                                                                                                                           |
| `pr_timeline_add`       | Put project clips (nodeIds from pr_project_info) on a Premiere Pro sequence's video track (1-based, default V1; linked audio follows on its own).                                                                                                                                                                                                                                                   |
| `pr_clip_edit`          | Change clips already on a Premiere Pro timeline (track item nodeIds from pr_sequence_info): `start` / `end` trim where the clip begins and ends on the timeline (seconds); `moveTo` moves it so it begins there, only through empty space (Premiere 26.3.2 breaks a clip moved across or onto others: to reorder, remove it and put it back with pr_timeline_add); `enabled` switches it off or on. |
| `pr_clip_remove`        | Remove clips from a Premiere Pro timeline (track item nodeIds from pr_sequence_info), with their audio unless withAudio is false; ripple closes the gap.                                                                                                                                                                                                                                            |
| `pr_razor`              | Cut (razor) every clip that crosses `time` (seconds) on the ACTIVE Premiere Pro sequence, video and audio together.                                                                                                                                                                                                                                                                                 |
| `pr_mogrt_add`          | Put a Motion Graphics template (.mogrt file) on a Premiere Pro sequence at `time` (seconds) on video track `track` (1 = V1).                                                                                                                                                                                                                                                                        |
| `pr_export`             | Export a Premiere Pro sequence (default the active one) to a file, rendered inside Premiere with a preset (.epr; default Premiere's H.264 "Match Source - High bitrate").                                                                                                                                                                                                                           |
| `pr_save_project`       | Save the open Premiere Pro project over its file.                                                                                                                                                                                                                                                                                                                                                   |
| `pr_import`             | Import into the Premiere Pro project: media files or whole folders (`files`, full paths), and/or compositions of an After Effects project (`aeProject`, a .aep; `aeComps` names some, omitted = all of them, linked through Dynamic Link).                                                                                                                                                          |
| `pr_sequence_duplicate` | Duplicate a Premiere Pro sequence (default the active one), optionally naming the copy - a safe version to work on.                                                                                                                                                                                                                                                                                 |
| `pr_sequence_open`      | Open a Premiere Pro sequence in the timeline and make it the active one (the razor and transitions work on the active sequence).                                                                                                                                                                                                                                                                    |
| `pr_tracks`             | Switch Premiere Pro tracks of a sequence (default the active one): `muted`, `locked`, `targeted`, for video (V1 = index 1) or audio tracks.                                                                                                                                                                                                                                                         |
| `pr_transition`         | Add a transition at the start (default) or end of clips on a Premiere Pro timeline (track item nodeIds from pr_sequence_info): video clips get Cross Dissolve, audio clips Constant Power, unless `name` says another Premiere transition.                                                                                                                                                          |
| `pr_audio_level`        | Set the volume of clips on a Premiere Pro timeline, in dB (0 = unchanged, -6 = half as loud).                                                                                                                                                                                                                                                                                                       |
| `pr_export_interchange` | Export a Premiere Pro sequence (default the active one) for another program: `xml` (Final Cut Pro XML, read by DaVinci Resolve and Final Cut), `aaf` or `omf` (for the sound mix, audio embedded, 48 kHz / 16 bit).                                                                                                                                                                                 |
| `pr_auto_reframe`       | Make a reframed copy of a Premiere Pro sequence (default the active one) for another aspect ratio - 9:16 for stories and reels, 1:1, 4:5 - with Premiere's Auto Reframe, which follows the action.                                                                                                                                                                                                  |
| `pr_captions`           | Add captions to a Premiere Pro sequence (default the active one) from a subtitle file (.srt, full path), starting at `start` seconds (default 0).                                                                                                                                                                                                                                                   |
| `pr_undo_last`          | Take back Claude's last change in Premiere Pro - the whole request, all its steps - the way the panel's Annulla button does.                                                                                                                                                                                                                                                                        |
