const { Program, quit, key, spinner, style } = require('bare-tui')
const tty = require('bare-tty')
const link = require('pear-link')

// The terminal UI, layered on top of the hello-pear-bare entrypoint.
//
// `bin.mjs` is the hello-pear-bare entrypoint plus `import TUI from './tui.js'`,
// a `--message` flag, and three lines:
//
//   const tui = TUI.start({ name, upgrade, message }) // null without a terminal
//   const console = tui ? tui.console : globalThis.console
//   tui?.attach(app)
//
// While the UI runs, `tui.console` takes every line `bin.mjs` would print, so
// nothing writes over the screen. `attach(app)` routes the worker's messages
// into the UI and ties the UI and the App together: quitting the UI closes the
// App, and closing the App (signals, startup failure) quits the UI.

// A small live console: a spinner header, a scrolling feed of worker IPC and
// log lines, and enter to ping the worker. This is the model the Program
// drives; see bare-tui for the framework and its components.
module.exports = class TUI {
  constructor({ name }) {
    this.name = name
    this.spinner = spinner.create({ fps: 12 })
    this.feed = []
    this.height = 24
    this.width = 80
    this.exitCode = 0
    this.onping = null // () => void, set by attach(app)
  }

  // Starts the UI when there is a terminal to draw on, otherwise returns null
  // and the app runs exactly like hello-pear-bare, printing plain lines.
  static start({ name, upgrade, message }) {
    if (!tty.isTTY(0) || !tty.isTTY(1)) return null

    // The worker throws on an invalid `upgrade` link, and an uncaught worker
    // error aborts the process before the UI can restore the terminal. Leave
    // that case to the plain output, which shows the error as hello-pear-bare
    // does.
    try {
      link.parse(upgrade)
    } catch {
      return null
    }

    return new Session(new TUI({ name }), { message })
  }

  init() {
    return this.spinner.init()
  }

  update(msg) {
    switch (msg.type) {
      case 'spinner.tick': {
        const [s, cmd] = this.spinner.update(msg)
        this.spinner = s
        return [this, cmd]
      }
      case 'resize':
        this.width = msg.width
        this.height = msg.height
        return [this, null]
      case 'worker':
        this._push(`‹ ${describe(msg.data)}`)
        return [this, null]
      case 'log':
        this._push(`  ${msg.line}`)
        return [this, null]
      case 'key':
        if (key.matches(msg, 'q')) return [this, quit]
        if (key.matches(msg, 'ctrl+c')) {
          this.exitCode = 130 // same code as a SIGINT
          return [this, quit]
        }
        if (key.matches(msg, 'enter')) {
          this._push('› ping')
          if (this.onping) this.onping()
        }
        return [this, null]
      default:
        return [this, null]
    }
  }

  _push(line) {
    for (const l of String(line).split('\n')) this.feed.push(l)
    const max = Math.max(1, this.height - 4)
    if (this.feed.length > max) this.feed = this.feed.slice(-max)
  }

  view() {
    const header = style()
      .bold(true)
      .foreground('magenta')
      .render(` ${this.spinner.view()} ${this.name} — live`)

    const body = style()
      .width(Math.max(1, this.width - 2))
      .height(Math.max(1, this.height - 4))
      .border(style.borders.rounded)
      .borderForeground('blue')
      .render(this.feed.join('\n') || 'waiting for worker…')

    const footer = style().faint(true).render(' enter ping · q quit')

    return style.joinVertical(style.position.left, header, body, footer)
  }
}

// A running UI: the bare-tui Program plus the glue to bin.mjs and the App.
class Session {
  constructor(model, { message } = {}) {
    this.model = model
    this.message = message || 'hello from tui' // sent to the worker once the App is ready
    this.program = new Program(model)
    this.errors = [] // error lines, printed again once the terminal is restored
    this.worker = [] // worker messages bin.mjs is about to log, shown as worker lines

    this.console = Object.create(globalThis.console)
    this.console.log = this.console.info = (...args) => this._log('info', args)
    this.console.warn = this.console.error = (...args) => this._log('error', args)

    this.done = this.program.run()

    // Every way out restores the terminal, including a Bare.exit() that does
    // not wait for the UI (bin.mjs exits that way when startup fails). Errors
    // are repeated after the UI is gone so they stay visible. When stderr is
    // the same terminal they go through the UI's own output stream: writes to
    // stderr could overtake the queued "leave the alt-screen" and be lost.
    Bare.on('exit', () => {
      this.program._teardown() // no-op if the UI already exited
      if (this.errors.length === 0) return
      if (tty.isTTY(2)) this.program.output.write(this.errors.join('\n') + '\n')
      else for (const line of this.errors) globalThis.console.error(line)
    })
  }

  attach(app) {
    // Worker messages reach the UI as worker lines. bin.mjs also logs each one
    // (`app.on('message', (message) => console.log(message))`, registered after
    // this listener), so that log line is skipped instead of shown twice.
    app.on('message', (data) => {
      this.worker.push(String(data))
      this.program.send({ type: 'worker', data })
    })

    // Talk to the worker over the App's IPC pipe: the --message text once the
    // App is ready, and `ping` on enter. The hello-pear-bare worker answers
    // anything it doesn't handle with `unknown-message <text>`.
    app.on('ready', () => app._send(this.message))
    this.model.onping = () => app._send('ping')

    // The App closes on signals and failed startups: leave the UI with it.
    app.on('close', () => this.program.quit())

    // Quitting the UI closes the App, unless it is already closing.
    this.done.then(
      () => {
        if (app.closing === null) app.exit(this.model.exitCode)
      },
      (err) => {
        this.errors.push('[tui:error] ' + format([err]))
        app.exit(1)
      }
    )
  }

  _log(level, args) {
    if (level === 'info' && args.length === 1 && args[0] === this.worker[0]) {
      this.worker.shift() // already shown as a worker line
      return
    }
    const line = format(args).replace(/^\n+|\n+$/g, '') // drop padding lines
    if (line === PLAIN_READY) return // the footer lists the keys instead
    if (level === 'error') this.errors.push(line)
    this.program.send({ type: 'log', level, line })
  }
}

// bin.mjs prints this once the App is ready. It is for the plain output: in the
// UI the footer already says how to quit.
const PLAIN_READY = 'CLI ready. Press Ctrl+C to stop.'

// The worker echoes anything it doesn't handle as `unknown-message <text>`.
// Show that as what it means for the user: the worker got the message.
function describe(data) {
  const text = String(data).trim()
  if (text.startsWith('unknown-message ')) return 'worker received: ' + text.slice(16)
  return text
}

function format(args) {
  return args.map(stringify).join(' ')
}

function stringify(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
