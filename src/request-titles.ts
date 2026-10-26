// What each request is called in the Parlez! panel's history: a few plain
// Italian words instead of the operation's technical name. The server knows
// the name (the request's label) and, for a batch, its steps; it sends the
// title along in the request (`title`), and the agent shows and logs it.
// Names missing from the table show as they are.
//
// A fixed table, not generated: these are words the user reads. (Testi
// provvisori: Anthony può cambiarli.)

const TITLES: Record<string, string> = {
  // Static tools (their request labels).
  context: "guarda la sessione",
  project_info: "guarda il progetto",
  comp_info: "guarda la composizione",
  layer_info: "guarda il livello",
  version_info: "versione di After Effects",
  render_frame: "renderizza fotogramma",
  save_project: "salva il progetto",
  project_export_json: "esporta il progetto in JSON",
  project_import_json: "importa progetto da JSON",
  // Node-side steps of checkpoint.* and aerender.
  "checkpoint.info": "punto di ripristino: lettura",
  "checkpoint.save": "punto di ripristino: salvataggio",
  "checkpoint.close": "punto di ripristino: chiude il progetto",
  "checkpoint.open": "punto di ripristino: riapre il progetto",
  "aerender.prep": "prepara il render in sottofondo",

  "batch.run": "lotto di operazioni",
  "eval.run": "codice libero",
  "recipe.run": "esegue una ricetta",
  "recipe.plan": "prepara una ricetta",
  "recipe.list": "elenco ricette",

  "checkpoint.create": "punto di ripristino",
  "checkpoint.list": "elenco punti di ripristino",
  "checkpoint.restore": "ripristina un punto",
  "checkpoint.delete": "cancella un punto di ripristino",

  "comp.audit": "controllo automatico",
  "comp.audit_motion": "controllo del movimento",
  "comp.create": "crea composizione",
  "comp.delete": "cancella composizione",
  "comp.duplicate": "duplica composizione",
  "comp.info": "guarda la composizione",
  "comp.precompose": "precomponi livelli",
  "comp.resize": "ridimensiona composizione",
  "comp.sample": "campiona i colori",
  "comp.set_props": "modifica composizione",
  "comp.set_work_area": "imposta area di lavoro",
  "comp.set_layer_order": "riordina livelli",
  "comp.add_guide": "aggiunge guida",
  "comp.remove_guide": "toglie guida",
  "comp.list_guides": "elenco guide",

  "layer.create_text": "crea livello di testo",
  "layer.create_shape": "crea livello forma",
  "layer.create_solid": "crea livello in tinta unita",
  "layer.create_null": "crea oggetto nullo",
  "layer.create_adjustment": "crea livello di regolazione",
  "layer.create_camera": "crea videocamera",
  "layer.create_light": "crea luce",
  "layer.create_footage": "aggiunge metraggio",
  "layer.delete": "cancella livello",
  "layer.duplicate": "duplica livello",
  "layer.info": "guarda il livello",
  "layer.move": "sposta livello",
  "layer.set_props": "modifica livello",
  "layer.set_parent": "imposta genitore",
  "layer.set_timing": "modifica tempi del livello",
  "layer.set_blend_mode": "metodo di fusione",
  "layer.set_track_matte": "imposta mascherino",
  "layer.set_anchor": "sposta punto di ancoraggio",
  "layer.set_enabled": "accende/spegne livello",
  "layer.split": "divide livello",
  "layer.stagger": "sfalsa livelli",
  "layer.bounds": "misura il livello",
  "layer.apply_preset": "applica preset",
  "layer.copy_to_comp": "copia livello in composizione",
  "layer.replace_source": "sostituisce sorgente",
  "layer.convert_to_shapes": "converte in forme",

  "keyframe.add": "aggiunge fotogramma chiave",
  "keyframe.apply": "applica fotogrammi chiave",
  "keyframe.apply_ease": "applica andamento",
  "keyframe.remove": "toglie fotogramma chiave",
  "keyframe.set_batch": "imposta fotogrammi chiave",
  "keyframe.set_easing": "imposta andamento",
  "keyframe.set_interpolation": "imposta interpolazione",
  "keyframe.set_value": "modifica fotogramma chiave",
  "keyframe.shift": "sposta fotogrammi chiave",
  "keyframe.copy": "copia fotogrammi chiave",

  "property.get": "legge proprietà",
  "property.set": "modifica proprietà",
  "property.list": "elenco proprietà",
  "property.add": "aggiunge proprietà",
  "property.remove": "toglie proprietà",
  "transform.set": "modifica trasformazioni",

  "effect.add": "aggiunge effetto",
  "effect.remove": "toglie effetto",
  "effect.set_property": "modifica effetto",
  "effect.list_on_layer": "elenco effetti",
  "effect.move": "sposta effetto",

  "expression.set": "imposta espressione",
  "expression.remove": "toglie espressione",
  "expression.apply_template": "applica modello di espressione",
  "expression.disable_all": "spegne le espressioni",
  "expression.restore_all": "riaccende le espressioni",

  "text.set_content": "modifica testo",
  "text.set_style": "stile del testo",
  "text.set_style_range": "stile di una parte del testo",
  "text.add_animator": "aggiunge animatore di testo",
  "text.measure": "misura il testo",
  "text.set_box": "imposta casella di testo",

  "shape.add_rect": "aggiunge rettangolo",
  "shape.add_ellipse": "aggiunge ellisse",
  "shape.add_path": "aggiunge tracciato",
  "shape.add_polystar": "aggiunge stella/poligono",
  "shape.add_fill": "aggiunge riempimento",
  "shape.add_stroke": "aggiunge traccia",
  "shape.add_gradient_fill": "aggiunge riempimento sfumato",
  "shape.add_group": "aggiunge gruppo di forme",
  "shape.add_trim_paths": "aggiunge rifila tracciati",
  "shape.add_repeater": "aggiunge ripetitore",
  "shape.recolor": "ricolora forme",

  "mask.add": "aggiunge maschera",
  "mask.remove": "toglie maschera",
  "mask.set_path": "modifica maschera",
  "mask.set_props": "proprietà della maschera",

  "marker.add_comp": "aggiunge marcatore",
  "marker.add_layer": "aggiunge marcatore al livello",
  "marker.list": "elenco marcatori",
  "marker.remove": "toglie marcatore",
  "marker.update": "modifica marcatore",

  "item.list": "elenco elementi",
  "item.set_props": "modifica elemento",
  "item.move_to_folder": "sposta in cartella",
  "folder.create": "crea cartella",

  "footage.replace": "sostituisce metraggio",
  "footage.reload": "ricarica metraggio",
  "footage.interpret": "interpreta metraggio",
  "footage.list_missing": "metraggi mancanti",

  "font.list": "elenco font",
  "font.list_missing": "font mancanti",
  "font.list_used": "font usati",

  "project.open": "apre progetto",
  "project.new": "nuovo progetto",
  "project.import_file": "importa file",
  "project.undo": "annulla",
  "project.purge": "svuota la cache",
  "project.find_layers": "cerca livelli",
  "project.list_effects": "elenco effetti disponibili",
  "project.get_settings": "impostazioni del progetto",
  "project.set_settings": "modifica impostazioni del progetto",
  "project.merge": "unisce progetti",
  "project.reduce": "riduce progetto",

  "render.frame": "renderizza fotogramma",
  "render.add_to_queue": "aggiunge alla coda di render",
  "render.start": "avvia il render",
  "render.status": "stato del render",
  "render.variants": "render di varianti",

  "aerender.start": "render in sottofondo",
  "aerender.status": "stato del render in sottofondo",
  "aerender.cancel": "ferma il render in sottofondo",

  "timeline.set_time": "sposta indicatore del tempo",
  "timeline.set_active_comp": "apre composizione",
  "timeline.select_layers": "seleziona livelli",
  "viewer.get_state": "guarda il visualizzatore",
  "viewer.set_options": "opzioni del visualizzatore",

  "reference.measure": "misura il riferimento",
  "frame.compare": "confronta fotogrammi",

  "instance.list": "elenco istanze",
  "instance.start": "avvia istanza",
  "instance.stop": "chiude istanza",
  "instance.dialogs": "finestre aperte",

  "command.execute": "comando di menu",
  "pref.get": "legge preferenza",
  "pref.set": "modifica preferenza",
};

const MAX_STEPS_SHOWN = 3;

/** The title for one name: the table's words, or the name itself. */
export function titleFor(name: string): string {
  return Object.prototype.hasOwnProperty.call(TITLES, name) ? TITLES[name] : name;
}

/**
 * The history line for a request: its title, and for a batch the number of
 * steps with the first few named — "lotto di 5 operazioni: crea livello di
 * testo, modifica testo, aggiunge effetto…".
 */
export function describeRequest(label: string, steps?: readonly string[]): string {
  if (label === "batch.run" && steps && steps.length > 0) {
    const shown = steps.slice(0, MAX_STEPS_SHOWN).map(titleFor).join(", ");
    const more = steps.length > MAX_STEPS_SHOWN ? "…" : "";
    const n = steps.length;
    return `lotto di ${n} ${n === 1 ? "operazione" : "operazioni"}: ${shown}${more}`;
  }
  return titleFor(label);
}

/** For tests: every name the table knows. */
export function knownTitles(): string[] {
  return Object.keys(TITLES);
}
