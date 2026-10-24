// New native-scroll contract supersedes the optional legacy reverse utility.
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
const source=readFileSync('public/store/store.js','utf8');
it('does not load or mount the legacy reversed-scroll controller',()=>{expect(source).not.toMatch(/import[^\n]*reverse-scroll|mountReverseScroll\s*\(/);});
it('does not register document-wide wheel or touch interception',()=>{expect(source).not.toMatch(/(?:window|document)\.addEventListener\(\s*['"](?:wheel|touchstart|touchmove)['"]/);});
it('allows native document overscroll while keeping the visual styles',()=>{const css=readFileSync('public/store/compact-masthead.css','utf8');expect(css).not.toMatch(/html\s*,\s*body\s*\{[^}]*overscroll-behavior-y:\s*(?:none|contain)/);expect(css).toContain('.ft-home-search.is-fixed');expect(css).toContain('.ft-promotion-product');});
