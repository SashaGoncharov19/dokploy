import dynamic from "next/dynamic";

/**
 * CodeMirror and its language modes are ~464KB - the single heaviest thing in
 * the dashboard bundle, and larger than React itself. Thirty-six call sites
 * import this component, all of them inside tabs, dialogs or settings panels
 * that most visits never open.
 *
 * Keeping the public name here and loading the implementation on demand means
 * none of those call sites had to change.
 */
export const CodeEditor = dynamic(
	() => import("./code-editor-impl").then((m) => m.CodeEditor),
	{ ssr: false },
);
