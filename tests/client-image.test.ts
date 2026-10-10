import test from 'node:test'
import assert from 'node:assert/strict'
import { generatedImage, createImageToolView, imageDictionaries } from '../src/client-image.ts'

const image = { attachmentId: 'sha256:test', mediaType: 'image/png', width: 1672, height: 941, bytes: 2870000, name: 'generated-image.png' }
const props = () => ({ phase: 'result', block: { content: [{ type: 'text', text: 'metadata' }, { type: 'image', attachment: image }] }, t: key => imageDictionaries.zh[key], loadImage: async () => 'blob:authorized' })
const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...(n.children ?? []).flatMap(nodes)]

function fixture() {
  let cells = [], cursor = 0, cleanup
  const runtime = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }] },
    useEffect(effect, deps) { const i = cursor++; if (cells[i] && deps.every((v, j) => v === cells[i][j])) return; cleanup?.(); cells[i] = deps; cleanup = effect() },
  }
  const View = createImageToolView(runtime, { DisclosureRow: 'disclosure', IconApiOutlineRegular: 'icon' })
  const outer = View(props()), preview = outer.children[0]
  cells = []
  return { render(value = preview.props) { cursor = 0; return preview.type(value) }, unmount() { cleanup?.() }, outer }
}
const settled = () => new Promise(resolve => setImmediate(resolve))

test('persisted root and nested image content supplies the preview without metadata', () => {
  for (const parentCallId of [undefined, 'run-code']) {
    const p = props(); p.block.parentCallId = parentCallId
    assert.equal(generatedImage(JSON.parse(JSON.stringify(p))).attachmentId, image.attachmentId)
  }
  for (const patch of [{ phase: 'start' }, { phase: 'preparing' }, { block: { isError: true, content: props().block.content } }, { block: { content: [{ type: 'image', attachment: { ...image, width: 0 } }] } }]) assert.equal(generatedImage({ ...props(), ...patch }), undefined)
})

test('session loader URL supplies image preview, original link, and named download', async () => {
  const f = fixture(); assert.equal(f.outer.props.open, true)
  f.render(); await settled()
  const all = nodes(f.render()), img = all.find(n => n.type === 'img'), download = all.find(n => n.props.download)
  assert.equal(img.props.src, 'blob:authorized'); assert.equal(img.props.width, 1672)
  assert.equal(download.props.href, img.props.src); assert.equal(download.props.download, image.name)
  assert.equal(all.find(n => n.props.target === '_blank').props.rel, 'noopener noreferrer')
  f.unmount()
})

test('load failure offers retry without generating another image', async () => {
  const f = fixture(); let calls = 0
  const value = { image, t: props().t, loadImage: async () => { if (++calls === 1) throw new Error('offline'); return 'blob:retry' } }
  f.render(value); await settled()
  const error = nodes(f.render(value))
  assert.ok(error.some(n => n.props.role === 'alert')); assert.ok(!error.some(n => n.type === 'img'))
  error.find(n => n.type === 'button').props.onClick()
  f.render(value); await settled()
  assert.equal(nodes(f.render(value)).find(n => n.type === 'img').props.src, 'blob:retry'); assert.equal(calls, 2)
  f.unmount()
})

test('changing image suppresses a stale loader result', async () => {
  const f = fixture(); let resolve
  const first = { image, t: props().t, loadImage: () => new Promise(r => { resolve = r }) }
  f.render(first); await settled()
  const second = { ...first, image: { ...image, attachmentId: 'sha256:next' }, loadImage: async () => 'blob:next' }
  f.render(second); await settled(); resolve('blob:stale'); await settled()
  assert.equal(nodes(f.render(second)).find(n => n.type === 'img').props.src, 'blob:next')
  f.unmount()
  assert.deepEqual(Object.keys(imageDictionaries.zh), Object.keys(imageDictionaries.en))
})
