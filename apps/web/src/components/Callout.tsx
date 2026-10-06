import type { ReactNode } from 'react';
import { ApiError, errorText } from '../lib/api';

export type CalloutKind = 'error' | 'blocked' | 'info';

// Each kind has its own icon, title word and border style, so it reads the same without color.
const ICON: Record<CalloutKind, string> = { error: '⚠', blocked: '⛔', info: 'ⓘ' };
const TITLE: Record<CalloutKind, string> = {
  error: 'That didn’t work',
  blocked: 'Not part of your access',
  info: 'Note',
};

/**
 * A boxed message that sits inside the screen instead of replacing it: the rest of the page
 * stays usable. Errors are announced to screen readers; notes are polite.
 */
export function Callout({
  kind = 'error',
  title,
  children,
  onDismiss,
}: {
  kind?: CalloutKind;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`callout callout-${kind}`} role={kind === 'info' ? 'status' : 'alert'}>
      <span className="callout-icon" aria-hidden="true">
        {ICON[kind]}
      </span>
      <div className="callout-body">
        <strong>{title ?? TITLE[kind]}</strong>
        <div>{children}</div>
      </div>
      {onDismiss && (
        <button type="button" className="btn small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

/** A failed request as a callout. Permission refusals get their own icon and title. */
export function ErrorCallout({ error, onDismiss, children }: { error: unknown; onDismiss?: () => void; children?: ReactNode }) {
  const blocked = error instanceof ApiError && error.status === 403;
  return (
    <Callout kind={blocked ? 'blocked' : 'error'} title={blocked ? 'You can’t do this with your account' : undefined} onDismiss={onDismiss}>
      {errorText(error)}
      {children}
    </Callout>
  );
}
