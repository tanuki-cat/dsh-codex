import type * as React from 'react'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UsagePrimitives } from './client-usage-command.js'

export interface ImageToolProps {
  phase: 'preparing' | 'start' | 'result'
  block: { isError?: boolean; content?: unknown[] }
  loadImage(ref: ImageAttachmentRef): Promise<string>
  t(key: string): string
}

/** Read persisted image blocks, including calls nested inside run_code. */
export function generatedImage(props: Pick<ImageToolProps, 'phase' | 'block'>): ImageAttachmentRef | undefined {
  if (props.phase !== 'result' || props.block.isError) return
  for (const block of props.block.content ?? []) {
    if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'image' || !('attachment' in block)) continue
    const ref = block.attachment as ImageAttachmentRef | undefined
    if (ref && typeof ref.attachmentId === 'string' && ref.attachmentId
      && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
      && [ref.width, ref.height, ref.bytes].every(n => Number.isSafeInteger(n) && n > 0)) return ref
  }
}

export const imageDictionaries = {
  zh: { title: '生成图片', preview: '生成的图片', download: '下载图片', open: '打开原图', failed: '图片加载失败，可重试', retry: '重试' },
  en: { title: 'Generate image', preview: 'Generated image', download: 'Download image', open: 'Open image', failed: 'Image could not load. Try again.', retry: 'Retry' },
}

export function createImageToolView(runtime: Pick<typeof React, 'createElement' | 'useState' | 'useEffect'>, primitives: UsagePrimitives) {
  const { createElement: h, useState, useEffect } = runtime
  function Preview({ image, loadImage, t }: { image: ImageAttachmentRef; loadImage: ImageToolProps['loadImage']; t: ImageToolProps['t'] }) {
    const [state, setState] = useState<{ image?: ImageAttachmentRef; url?: string; failed?: boolean }>({})
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      let active = true
      setState({ image })
      Promise.resolve().then(() => loadImage(image)).then(url => { if (active) setState({ image, url }) }, () => { if (active) setState({ image, failed: true }) })
      // Attachment URLs belong to the session loader, not this view.
      return () => { active = false }
    }, [image, loadImage, attempt])
    const current = state.image === image ? state : {}
    return h('div', { className: 'dsh-codex-image-card' },
      current.url ? h('a', { href: current.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': t('open') },
        h('img', { src: current.url, alt: image.name || t('preview'), width: image.width, height: image.height })) : null,
      h('div', { className: 'dsh-codex-image-actions' },
        h('span', null, image.width + ' × ' + image.height),
        current.url ? h('a', { className: 'dsh-chatgpt-link', href: current.url, download: image.name || 'generated-image.' + image.mediaType.split('/')[1] }, t('download')) : null),
      current.failed ? h('div', { role: 'alert' }, t('failed'), ' ', h('button', { type: 'button', className: 'dsh-chatgpt-button', onClick: () => setAttempt(n => n + 1) }, t('retry'))) : null,
      !current.url && !current.failed ? h('span', { className: 'dsh-chatgpt-spinner', 'aria-hidden': true }) : null)
  }
  return function ImageToolView(props: ImageToolProps) {
    const [open, setOpen] = useState(true)
    const image = generatedImage(props)
    const text = (props.block.content ?? []).filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && 'type' in b && b.type === 'text' && 'text' in b && typeof b.text === 'string').map(b => b.text).join('\n')
    const body = image ? h(Preview, { image, loadImage: props.loadImage, t: props.t }) : text ? h('pre', { className: 'dsh-codex-command-fallback', 'data-error': props.block.isError }, text) : null
    return h(primitives.DisclosureRow, { icon: h(primitives.IconApiOutlineRegular, { size: 14 }), title: props.t('title'),
      open: open && !!body, expandable: !!body, running: props.phase !== 'result', expandOnRowClick: true,
      onToggle: () => setOpen(value => !value) }, open ? body : null)
  }
}

export const imageCss = '.dsh-codex-image-card{display:flex;flex-direction:column;gap:8px;margin:4px 0;padding:12px 16px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-primary)}' +
  '.dsh-codex-image-card img{display:block;max-width:100%;height:auto;border-radius:var(--dsw-radius-sm)}' +
  '.dsh-codex-image-actions{display:flex;align-items:center;gap:16px;font-size:var(--dsh-content-font-size-secondary)}'
