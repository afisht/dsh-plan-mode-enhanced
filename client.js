/**
 * dsh-plan-mode-enhanced
 *
 * Takes over the plan-review card in the composer seat and adds a feedback
 * box: the plan stays visible while you type revision requests, and the
 * feedback is sent back to the model as the answer's `custom` field (the
 * host's plan-mode service already routes any answer with `custom` to the
 * keep-planning branch, so the model sees "their feedback: <text>" and
 * revises the plan).
 *
 * Implementation: `conversation.composer` is a chain slot — selects run in
 * ascending priority order and the first non-null match wins. The official
 * ui-user-questions card registers at priority 0; this plugin registers at
 * priority -20 and only matches plan-review interactions, so it takes over
 * that card while every other question falls through to the official flow.
 *
 * Hand-authored CJS bundle (no build step), mirroring dsh-open-explorer /
 * dshmarket; externals come from the loader's static module table
 * (react, @deepseek-ai/dsh-client-ui-primitives).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plan-mode-enhanced',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useState, useMemo, useEffect } = React
    const { createPortal } = require('react-dom')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const MarkdownText = P.MarkdownText
    const Button = P.Button
    const IconEditOutline16 = P.IconEditOutline16
    const IconCloseFill14 = P.IconCloseFill14

    /** Minimal zh/en switch mirroring the official card's locale behavior. */
    function zh() {
      return typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language || '')
    }
    const t = (key) => ({
      header: zh() ? '计划待审' : 'Plan review',
      approve: zh() ? '确认执行' : 'Approve',
      decline: zh() ? '拒绝' : 'Refuse',
      discuss: zh() ? '去聊天里说' : 'Chat about it',
      preview: zh() ? '预览计划' : 'Preview plan',
      previewTitle: zh() ? '计划预览' : 'Plan Preview',
      close: zh() ? '关闭' : 'Close',
      feedbackPlaceholder: zh() ? '输入修改意见，模型将据此修改计划' : 'Enter feedback to revise the plan',
      feedbackHint: zh() ? '修改意见将带给模型重新规划' : 'Feedback is sent to the model to revise the plan',
      submit: zh() ? '提交修改意见' : 'Submit feedback',
    })[key]

    /**
     * Narrow a question batch to a plan-review card, mirroring the official
     * planReviewOf predicate so the takeover matches exactly what the official
     * card would have rendered.
     * @returns the matched question, or undefined.
     */
    function planReviewOf(questions) {
      if (questions.length !== 1) return void 0
      const question = questions[0]
      const intent = question.intent
      if (intent?.kind !== 'plan-review' || question.detail === void 0) return void 0
      if (question.multiSelect === true) return void 0
      const options = question.options ?? []
      if (options.length > 2) return void 0
      const approve = options.find((option) => option.label === intent.approve)
      if (approve === void 0) return void 0
      const decline = options.find((option) => option.label !== intent.approve)
      return { question, approve, ...decline === void 0 ? {} : { decline } }
    }

    /** Wire encoding of one pending question (mirror of the official PendingQuestion). */
    async function encodeAnswer(wait, answers) {
      const receipt = await wait.respond({
        ok: true,
        value: { sessionId: wait.sessionId, answer: { answers } },
      })
      // The host rejects an answer that does not match the pending question
      // (e.g. options/custom constraints); a rejected receipt must surface as
      // an error, otherwise the card stays busy and the tool call hangs.
      if (!receipt.accepted) throw new Error(`question response rejected: ${receipt.reason}`)
    }
    function encodeCancel(wait) {
      return wait.respond({
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      })
    }

    /**
     * Self-drawn right-side preview panel: a fixed right panel (visuals follow
     * the better-sidebar preview) rendering the plan markdown directly from the
     * card's in-hand content — no temp file, no host round-trip, no external
     * dependency. Rendered via portal onto document.body; Esc or the close
     * button dismisses it. No mask: the chat stays interactive underneath so
     * the user can read the plan and type feedback at the same time.
     */
    function PreviewPanel({ plan, title, onClose }) {
      useEffect(() => {
        const onKeyDown = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onClose])
      return createPortal(
        h(React.Fragment, null,
          h('div', {
            className: 'dshpr_mask',
            onClick: onClose,
            'aria-hidden': 'true',
          }),
          h('aside', {
            className: 'dshpr_panel',
            role: 'dialog',
            'aria-label': title,
            'data-plan-preview': true,
          },
            h('div', { className: 'dshpr_panelHeader' },
              h('span', { className: 'dshpr_panelTitle' }, title),
              h('button', {
                type: 'button',
                className: 'dshpr_panelClose',
                'aria-label': t('close'),
                title: t('close') + ' (Esc)',
                onClick: onClose,
              }, h(IconCloseFill14, { size: 14 }))),
            h('div', { className: 'dshpr_panelBody' },
              h(MarkdownText, { text: plan })))),
        document.body)
    }

    function PlanReviewPanel({ matched }) {
      const wait = matched
      const review = useMemo(() => {
        const found = planReviewOf(wait.payload.questions ?? [])
        return found === void 0 ? null : found
      }, [wait])
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [feedback, setFeedback] = useState('')

      const settle = (send) => {
        setBusy(true)
        setError(null)
        send().catch((cause) => {
          setBusy(false)
          setError(cause instanceof Error ? cause.message : String(cause))
        })
      }
      const decide = (label) => {
        settle(() => encodeAnswer(wait, [{ id: review.question.id, selected: [label] }]))
      }
      const submitFeedback = () => {
        const text = feedback.trim()
        if (text === '') return
        // The host's matchesQuestions gate rejects a single-select question
        // whose answer carries both a custom and a non-empty selected list, so
        // feedback-only answers must leave selected empty.
        settle(() => encodeAnswer(wait, [{
          id: review.question.id,
          selected: [],
          custom: text,
        }]))
      }
      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          submitFeedback()
        }
      }

      // "Preview plan" button: open a self-drawn right-side preview panel
      // (no external dependency — the plan markdown is already in hand, so no
      // temp file or host round-trip is involved).
      const [previewOpen, setPreviewOpen] = useState(false)
      const openPreview = () => {
        if (review === null) return
        setPreviewOpen(true)
      }

      if (review === null) return null
      return h(React.Fragment, null,
        h('div', { className: 'dshpr_frame', 'data-plan-review-key': wait.key },
        h('section', { className: 'dshpr_card', 'aria-label': review.question.question },
          h('div', { className: 'dshpr_strip' },
            h('span', { className: 'dshpr_dot' }),
            h('span', { className: 'dshpr_stripTitle' }, t('header')),
            h(Button, {
              variant: 'ghost',
              className: 'dshpr_preview',
              disabled: busy,
              onClick: openPreview,
            }, t('preview'))),
          h('div', { className: 'dshpr_body', 'data-plan-review-scroll': true },
            h(MarkdownText, { text: review.question.detail })),
          h('div', { className: 'dshpr_feedbackBox' },
            h('textarea', {
              className: 'dshpr_textarea',
              value: feedback,
              onChange: (e) => setFeedback(e.target.value),
              onKeyDown: onKeyDown,
              placeholder: t('feedbackPlaceholder'),
              rows: 2,
              'aria-label': t('feedbackPlaceholder'),
            }),
            h('div', { className: 'dshpr_submitRow' },
              h('span', { className: 'dshpr_hint' }, t('feedbackHint')),
              h(Button, {
                variant: 'primary',
                className: 'dshpr_submit',
                disabled: busy || feedback.trim() === '',
                onClick: submitFeedback,
              }, t('submit')))),
          h('div', { className: 'dshpr_footer' },
            h('div', { className: 'dshpr_feedback', role: 'status' }, error),
            h('div', { className: 'dshpr_actions' },
              h(Button, {
                variant: 'ghost',
                className: 'dshpr_discuss',
                icon: h(IconEditOutline16, { size: 14 }),
                disabled: busy,
                onClick: () => { settle(() => encodeCancel(wait)) },
              }, t('discuss')),
              review.decline !== void 0 && h(Button, {
                variant: 'outline',
                disabled: busy,
                onClick: () => { decide(review.decline.label) },
              }, t('decline')),
              h(Button, {
                variant: 'primary',
                disabled: busy,
                onClick: () => { decide(review.approve.label) },
              }, t('approve')))))),
        previewOpen && h(PreviewPanel, {
          plan: review.question.detail,
          title: t('previewTitle'),
          onClose: () => setPreviewOpen(false),
        }))
    }

    const css = [
      '.dshpr_frame{padding:6px calc(var(--dsh-composer-side-clearance, 16px) + 16px) 10px;justify-content:center;display:flex}',
      '.dshpr_card{width:100%;max-width:var(--dsh-chat-content-width);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-specific-input-major);max-height:min(60vh,520px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:20px;flex-direction:column;display:flex;overflow:hidden}',
      '.dshpr_card,.dshpr_card *{box-sizing:border-box}',
      '.dshpr_strip{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);flex-shrink:0;align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}',
      '.dshpr_stripTitle{flex:1;min-width:0}',
      '.dshpr_preview{color:var(--dsw-alias-state-warn-primary);flex-shrink:0;gap:4px}',
      '.dshpr_preview:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dshpr_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;width:8px;height:8px}',
      '.dshpr_body{overscroll-behavior:contain;flex:auto;min-height:0;padding:12px 16px 4px;font-size:14px;line-height:22px;overflow-y:auto}',
      '.dshpr_feedbackBox{flex-shrink:0;padding:8px 16px 4px;display:flex;flex-direction:column;gap:6px}',
      '.dshpr_textarea{resize:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);min-height:56px;max-height:140px;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font:inherit;border-radius:10px;outline:none;padding:8px 12px;font-size:14px;line-height:22px;display:block}',
      '.dshpr_textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshpr_textarea::placeholder{color:var(--dsw-alias-label-caption)}',
      '.dshpr_submitRow{justify-content:space-between;align-items:center;gap:12px;display:flex}',
      '.dshpr_hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:1;min-width:0}',
      '.dshpr_footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;padding:8px 16px 12px;display:flex}',
      '.dshpr_feedback{min-height:16px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}',
      '.dshpr_actions{flex-shrink:0;align-items:center;gap:8px;display:flex}',
      '.dshpr_discuss{color:var(--dsw-alias-label-secondary);gap:6px}',
      '.dshpr_discuss:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dshpr_panel{position:fixed;top:0;right:0;bottom:0;width:min(560px,90vw);background:var(--dsw-specific-sidebar-fill);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex-direction:column;display:flex;z-index:100}',
      '.dshpr_mask{position:fixed;inset:0;background:rgba(0,0,0,0.2);z-index:99}',
      '.dshpr_panel,.dshpr_panel *{box-sizing:border-box}',
      '.dshpr_panelHeader{flex-shrink:0;justify-content:space-between;align-items:center;gap:8px;height:36px;padding:0 6px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:flex}',
      '.dshpr_panelTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12)}',
      '.dshpr_panelClose{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;align-items:center;justify-content:center;display:inline-flex}',
      '.dshpr_panelClose:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshpr_panelBody{overscroll-behavior:contain;flex:1;min-height:0;padding:12px 16px;font:var(--dsw-font-xs-13);line-height:22px;overflow-y:auto}',
      '@media (width<=720px){.dshpr_card{border-radius:16px}.dshpr_body{padding:10px 12px 4px}.dshpr_footer{align-items:flex-end;padding:8px 12px 10px}.dshpr_feedbackBox{padding:8px 12px 4px}.dshpr_panel{width:100%}}',
    ].join('')
    const tagId = 'dsh-plan-mode-enhanced/PlanReviewPanel.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plan-mode-enhanced'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    exports.name = 'dsh-plan-mode-enhanced'
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -20,
        select: ({ interactions }) => {
          const interaction = interactions.find((i) => i.kind === 'question')
          if (interaction === void 0) return null
          const questions = interaction.payload?.questions
          if (!Array.isArray(questions) || questions.length === 0) return null
          if (planReviewOf(questions) === void 0) return null
          return interaction
        },
      }, PlanReviewPanel)), 'dsh-plan-mode-enhanced: plan review card')
    }

    return module.exports
  },
})
