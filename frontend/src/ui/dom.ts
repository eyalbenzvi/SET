/**
 * Tiny DOM helpers.
 *
 * Everything user-supplied (player names, room codes, server messages) is set
 * through `textContent`. The app never assigns `innerHTML`, so there is no path
 * from remote data to markup.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

export interface ElementOptions {
  class?: string;
  text?: string;
  attrs?: Attrs;
  children?: (Node | null | undefined)[];
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of options.children ?? []) {
    if (child) node.appendChild(child);
  }
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  return node;
}

export function button(
  label: string,
  variant: 'primary' | 'secondary' | 'ghost' | 'danger',
  onClick: () => void,
  options: { disabled?: boolean; class?: string; attrs?: Attrs } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: `btn btn--${variant}${options.class ? ` ${options.class}` : ''}`,
    text: label,
    attrs: { type: 'button', ...options.attrs },
    on: { click: () => onClick() },
  });
  node.disabled = options.disabled === true;
  return node;
}

/** Replace a container's children in one operation. */
export function render(container: Element, ...children: (Node | null | undefined)[]): void {
  container.replaceChildren(...children.filter((child): child is Node => Boolean(child)));
}

/** True when the player asked the system to minimise motion. */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
