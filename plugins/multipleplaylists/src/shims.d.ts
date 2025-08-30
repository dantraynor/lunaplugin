declare module "@luna/core" {
  export type LunaUnload = unknown;
  export function Tracer(scope: string): { trace: any; errSignal: any };
}

declare module "@luna/lib" {
  export const redux: any;
  export const ContextMenu: any;
  export const MediaItem: any;
}

declare module "@luna/ui" {
  export const LunaSettings: any;
  export const LunaSwitchSetting: any;
}

declare module "react" {
  const React: any;
  export default React;
}

// JSX runtime shims for react-jsx
declare module "react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}
