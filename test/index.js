const { test } = require('brittle')
const { KeyMsg, quit } = require('bare-tui')
const TUI = require('../tui.js')

const press = (name, mods = {}) => new KeyMsg({ name, ...mods })
const log = (line) => ({ type: 'log', level: 'info', line })
const worker = (data) => ({ type: 'worker', data })
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '') // eslint-disable-line no-control-regex

function create() {
  const tui = new TUI({ name: 'hello' })
  tui.update({ type: 'resize', width: 60, height: 12 })
  return tui
}

test('renders header, empty feed and keys', (t) => {
  const view = plain(create().view())
  t.ok(view.includes('hello — live'))
  t.ok(view.includes('waiting for worker…'))
  t.ok(view.includes('enter ping · q quit'))
})

test('fits the terminal', (t) => {
  const tui = create()
  tui.update(log('x'.repeat(100)))
  const rows = plain(tui.view()).split('\n')
  t.is(rows.length, 12)
  t.ok(
    rows.slice(1, -1).every((row) => [...row.trimEnd()].length === 60),
    'feed box is as wide as the terminal'
  )
})

test('worker messages and log lines', (t) => {
  const tui = create()
  tui.update(log('hello v1.0.0'))
  tui.update(worker('Hello from worker\n'))
  const view = plain(tui.view())
  t.ok(view.includes('  hello v1.0.0'))
  t.ok(view.includes('‹ Hello from worker'))
})

test('worker echoes read as received', (t) => {
  const tui = create()
  tui.update(worker('unknown-message hello from tui'))
  t.ok(plain(tui.view()).includes('‹ worker received: hello from tui'))
})

test('feed keeps the newest lines that fit', (t) => {
  const tui = create()
  for (let i = 0; i < 50; i++) tui.update(log('line ' + i))
  t.is(tui.feed.length, 8) // height 12 - header - footer - borders
  t.ok(plain(tui.view()).includes('line 49'))
  t.absent(plain(tui.view()).includes('line 41'))
})

test('enter pings the worker', (t) => {
  const tui = create()
  let pings = 0
  tui.onping = () => pings++
  tui.update(press('return'))
  t.is(pings, 1)
  t.ok(plain(tui.view()).includes('› ping'))
})

test('q quits with 0, ctrl+c with 130', (t) => {
  const a = create()
  t.is(a.update(press('q'))[1], quit)
  t.is(a.exitCode, 0)

  const b = create()
  t.is(b.update(press('c', { ctrl: true }))[1], quit)
  t.is(b.exitCode, 130)
})

test('no UI with an invalid upgrade link', (t) => {
  // The worker would abort on it, so start() falls back to plain output. This
  // also holds without a terminal, whichever way the tests are run.
  t.is(TUI.start({ name: 'hello', upgrade: 'pear://x' }), null)
})
