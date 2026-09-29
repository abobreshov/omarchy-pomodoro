// Test harness for Timer.js: drives the reducer at a simulated clock,
// collects the effects and answers every `record` effect through
// `answer(effect)`, feeding the reply back as Service.qml does.
//
//   answer(effect) -> { exitCode, exitStatus?, stdout?, stderr? } | null
//
// `null` leaves the record pending (the test answers it later with
// `reply(effect, result)`). Every `apply` also checks that `reduce` left its
// input state untouched (PLAN §7.3: the reducer is pure).
export class Sim {
  constructor(T, cfg, { now = 0, answer = null } = {}) {
    this.T = T
    this.cfg = cfg
    this.now = now
    this.state = T.initialState()
    this.effects = []
    this.answer = answer
  }

  apply(event) {
    const before = JSON.stringify(this.state)
    const out = this.T.reduce(this.state, event, this.now, this.cfg)
    if (JSON.stringify(this.state) !== before) throw new Error("reduce mutated its input state on " + JSON.stringify(event))
    this.state = out.state
    for (const e of out.effects) this.handle(e)
    return out.reply
  }

  handle(e) {
    this.effects.push(e)
    if (e.type !== "record" || !this.answer) return
    const r = this.answer(e)
    if (r) this.reply(e, r)
  }

  reply(e, r) {
    this.apply({ type: "recordResult", id: e.id, exitCode: r.exitCode, exitStatus: r.exitStatus || 0, stdout: r.stdout || "", stderr: r.stderr || "" })
  }

  // Restore from a saved state-file document (the service dispatches the raw text).
  restore(saved, settingsKnown) {
    const event = { type: "serviceStart", text: typeof saved === "string" ? saved : JSON.stringify(saved) }
    if (settingsKnown !== undefined) event.settingsKnown = settingsKnown
    return this.apply(event)
  }

  tick(seconds) {
    for (let i = 0; i < seconds; i++) {
      this.now += 1000
      this.apply({ type: "tick" })
    }
  }

  records() { return this.effects.filter((e) => e.type === "record") }
  verbs() { return this.records().map((e) => e.verb) }
  writes() { return this.effects.filter((e) => e.type === "writeState") }
  notifies() { return this.effects.filter((e) => e.type === "notify") }
  sounds() { return this.effects.filter((e) => e.type === "sound") }
  clear() { this.effects = [] }
}
