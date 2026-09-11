import vm from "node:vm";

type Listener = (event: any) => void;

class FakeClassList {
  private readonly values = new Set<string>();
  constructor(initial = "") {
    for (const value of initial.split(/\s+/).filter(Boolean)) this.values.add(value);
  }
  toggle(value: string, force?: boolean): boolean {
    const next = force ?? !this.values.has(value);
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
  contains(value: string): boolean {
    return this.values.has(value);
  }
  add(value: string): void {
    this.values.add(value);
  }
  remove(value: string): void {
    this.values.delete(value);
  }
}

export class FakeElement {
  value = "";
  disabled = false;
  textContent = "";
  title = "";
  className = "";
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  open = false;
  hidden = false;
  tabIndex = 0;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  readonly tagName: string;
  private readonly listeners = new Map<string, Listener[]>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly id = "", tagName = "DIV", private readonly owner?: FakeDocument) {
    this.tagName = tagName.toUpperCase();
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatch(type: string, extra: Record<string, unknown> = {}): void {
    const event = { type, target: this, preventDefault() {}, ...extra };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  click(): void {
    this.dispatch("click");
  }

  focus(): void {
    if (this.owner) this.owner.activeElement = this;
  }

  blur(): void {
    this.dispatch("blur");
    if (this.owner?.activeElement === this) this.owner.activeElement = null;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  querySelector(_selector: string): FakeElement {
    return new FakeElement("", "div", this.owner);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.attributes.has(name);
    if (next) this.attributes.set(name, ""); else this.attributes.delete(name);
    return next;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  private readonly elements = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(html: string) {
    for (const match of html.matchAll(/<([a-zA-Z0-9-]+)[^>]*\sid="([^"]+)"[^>]*>/g)) {
      this.elements.set(match[2], new FakeElement(match[2], match[1], this));
    }
    this.getElementById("languageSelect").value = "auto";
    const textarea = html.match(/<textarea[^>]*id="trustedBrowserOriginsInput"[^>]*>([\s\S]*?)<\/textarea>/);
    this.getElementById("trustedBrowserOriginsInput").value = decodeHtml(textarea?.[1] ?? "");
  }

  getElementById(id: string): FakeElement {
    let element = this.elements.get(id);
    if (!element) {
      element = new FakeElement(id, "div", this);
      this.elements.set(id, element);
    }
    return element;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement("", tag, this);
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function executePanelHtml(html: string): {
  element(id: string): FakeElement;
  posted: any[];
  dispatchMessage(data: any): void;
} {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  if (scripts.length < 2) throw new Error(`Expected at least two inline scripts, got ${scripts.length}.`);
  const document = new FakeDocument(html);
  const posted: any[] = [];
  const windowListeners = new Map<string, Listener[]>();
  const windowObject: any = {
    alert() {},
    confirm: () => true,
    addEventListener(type: string, listener: Listener) {
      const list = windowListeners.get(type) ?? [];
      list.push(listener);
      windowListeners.set(type, list);
    },
  };
  const sandbox: any = {
    window: windowObject,
    document,
    console,
    Date,
    Set,
    Map,
    Number,
    String,
    Array,
    JSON,
    Math,
    Error,
    Promise,
    acquireVsCodeApi: () => ({ postMessage: (message: any) => posted.push(message) }),
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout,
    clearTimeout,
  };
  windowObject.window = windowObject;
  const context = vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script, context, { timeout: 2_000 });
  return {
    element: (id: string) => document.getElementById(id),
    posted,
    dispatchMessage(data: any): void {
      for (const listener of windowListeners.get("message") ?? []) listener({ data });
    },
  };
}

export function createFakeWebviewView(): any {
  const posted: any[] = [];
  let messageHandler: ((message: any) => void) | undefined;
  const webview = {
    html: "",
    options: {},
    cspSource: "vscode-test:",
    posted,
    postMessage(message: any): Promise<boolean> {
      posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage(handler: (message: any) => void) {
      messageHandler = handler;
      return { dispose() {} };
    },
    receive(message: any): void {
      if (!messageHandler) throw new Error("Webview message handler is not registered.");
      messageHandler(message);
    },
  };
  return {
    visible: false,
    webview,
    onDidChangeVisibility() { return { dispose() {} }; },
    onDidDispose() { return { dispose() {} }; },
  };
}

export async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
