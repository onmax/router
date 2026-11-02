import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { codegen } from './sfc-typed-router'

const ROOT_DIR = '/app'
const FILE_NAME = '/app/src/pages/users/sub-[first]-[second].vue'
const FILE_PATH = `"src/pages/users/sub-[first]-[second].vue"`
const EXPECTED_TYPE_PARAM = `<import('vue-router/auto-routes')._RouteNamesForFilePath<${FILE_PATH}>>`
const ROUTE_PROPS = `import('vue-router/experimental')._RoutePropsForFilePath<${FILE_PATH}>`

/**
 * Runs the plugin's `rewrite` over a standalone `<script setup>` body and
 * applies its inserts: `insertAfter` attaches code to the char before the
 * offset and `insertBefore` to the char at it, as `@vue/content-mapper` does.
 */
function rewrite(code: string, { lang = 'ts', fileName = FILE_NAME } = {}) {
  const ast = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const after = new Map<number, string>()
  const before = new Map<number, string>()
  const plugin = codegen(
    { ts, fileName, ir: { scriptSetup: { lang, ast } } },
    { config: { options: { rootDir: ROOT_DIR } } }
  )
  plugin.rewrite({
    scriptSetup: {
      insertAfter: (offset, text) =>
        after.set(offset, text + (after.get(offset) ?? '')),
      insertBefore: (offset, text) =>
        before.set(offset, (before.get(offset) ?? '') + text),
    },
  })
  let out = ''
  for (let i = 0; i <= code.length; i++) {
    out += (after.get(i) ?? '') + (before.get(i) ?? '') + (code[i] ?? '')
  }
  return { code: out, plugin }
}

const transform = (code: string, opts?: Parameters<typeof rewrite>[1]) =>
  rewrite(code, opts).code

describe('sfc-typed-router content mapper plugin', () => {
  it('narrows the `useRoute()` call', () => {
    expect(transform(`const route = useRoute()`)).toContain(
      `useRoute${EXPECTED_TYPE_PARAM}()`
    )
  })

  it('narrows `typeof useRoute` in a type context', () => {
    expect(transform(`type R = ReturnType<typeof useRoute>`)).toContain(
      `typeof useRoute${EXPECTED_TYPE_PARAM}>`
    )
  })

  it('casts `useRoute()` with JSDoc in a js script', () => {
    expect(transform(`const route = useRoute()`, { lang: 'js' })).toContain(
      `/** @type {ReturnType<typeof import('vue-router').useRoute${EXPECTED_TYPE_PARAM}>} */ (useRoute())`
    )
  })

  it('types `$route` in the template', () => {
    expect(rewrite('').plugin.templateContext()).toEqual([
      `{ $route: ReturnType<typeof import('vue-router').useRoute${EXPECTED_TYPE_PARAM}> }`,
    ])
  })

  it('injects the file path and the page component into `definePage()`', () => {
    expect(transform(`definePage({ props: true })`)).toContain(
      `definePage<${FILE_PATH}, typeof import("./sub-[first]-[second].vue").default>(`
    )
  })

  it('escapes quotes in the file path and the self import', () => {
    expect(
      transform(`definePage({ props: true })`, {
        fileName: `/app/src/pages/it's-"fine".vue`,
      })
    ).toContain(
      `definePage<"src/pages/it's-\\"fine\\".vue", typeof import("./it's-\\"fine\\".vue").default>(`
    )
  })

  it('only injects the file path into `definePage()` without props', () => {
    for (const code of [`definePage({})`, `definePage({ props: false })`]) {
      expect(transform(code)).toContain(`definePage<${FILE_PATH}>(`)
    }
  })

  describe('defineProps() with `props: true`', () => {
    it('adds the route props to the call and to the component props', () => {
      const { code, plugin } = rewrite(
        `const props = defineProps()\ndefinePage({ props: true })`
      )
      expect(code).toContain(`defineProps<${ROUTE_PROPS}>()`)
      expect(plugin.props()).toEqual([{ type: ROUTE_PROPS }])
    })

    it('intersects the route props with a type argument', () => {
      const { code, plugin } = rewrite(
        `const props = defineProps<A & Omit<B, 'c'> | C>()\ndefinePage({ props: true })`
      )
      expect(code).toContain(
        `defineProps<${ROUTE_PROPS} & (A & Omit<B, 'c'> | C)>()`
      )
      expect(plugin.props()).toEqual([])
    })
  })
})
