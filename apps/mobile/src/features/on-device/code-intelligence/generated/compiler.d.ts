import type TS from 'typescript';
declare const compiler: typeof TS;
export default compiler;
export const libraries: Readonly<Record<string, string>>;
