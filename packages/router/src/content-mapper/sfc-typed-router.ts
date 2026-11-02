import { basename, relative } from 'pathe'
import type ts from 'typescript'

/**
 * The parts of `@vue/content-mapper`'s `VueCodegenPlugin` API that this plugin uses.
 * See https://github.com/vuejs/language-tools/tree/master/packages/content-mapper#codegen-plugins
 */
interface CodegenFile {
  /** The TS 7.1 AST API that parsed the scripts */
  ts: typeof ts
  fileName: string
  ir: { scriptSetup?: { lang: string; ast: ts.SourceFile } }
}

interface CodegenWriter {
  insertBefore(offset: number, code: string): void
  insertAfter(offset: number, code: string): void
}

/**
 * TypeScript 7.1 content mapper counterpart of the `sfc-typed-router` Volar plugin, for
 * `@vue/content-mapper`. List it in the `plugins` of the mapper entry, with the absolute
 * path of the root passed to the VueRouter unplugin, as codegen cannot resolve a relative one:
 * `{ "name": "vue-router/content-mapper/sfc-typed-router", "options": { "rootDir": "/abs/path" } }`
 */
export function codegen(
  { ts, fileName, ir }: CodegenFile,
  { config: { options } }: { config: { options?: { rootDir?: string } } }
) {
  const rootDir = options?.rootDir
  const filePath = JSON.stringify(
    rootDir ? relative(rootDir, fileName) : fileName
  )

  const useRouteNameTypeParam = `<import('vue-router/auto-routes')._RouteNamesForFilePath<${filePath}>>`
  const routeType = `ReturnType<typeof import('vue-router').useRoute${useRouteNameTypeParam}>`
  const definePageTypeParams = `<${filePath}>`
  // the self import is only added when needed because it is costly
  const definePageWithPropsTypeParams = `<${filePath}, typeof import(${JSON.stringify(`./${basename(fileName)}`)}).default>`
  const routePropsType = `import('vue-router/experimental')._RoutePropsForFilePath<${filePath}>`

  const routeProps: { type: string }[] = []

  return {
    rewrite({ scriptSetup }: { scriptSetup?: CodegenWriter }) {
      const block = ir.scriptSetup
      if (!block || !scriptSetup) return
      const { ast } = block
      // JavaScript components are checked as JavaScript, so `useRoute()` gets a JSDoc cast
      const isJs = block.lang.startsWith('js')

      // `definePage()` can come after `defineProps()`
      const hasPropsTrue =
        !isJs &&
        ast.statements.some(
          statement =>
            ts.isExpressionStatement(statement) &&
            isDefinePageCall(statement.expression) &&
            getPropsOption(statement.expression)?.kind ===
              ts.SyntaxKind.TrueKeyword
        )

      ast.forEachChild(function visit(node) {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'useRoute' &&
          !node.typeArguments &&
          !node.arguments.length
        ) {
          if (isJs) {
            scriptSetup.insertBefore(
              node.getStart(ast),
              `/** @type {${routeType}} */ (`
            )
            scriptSetup.insertAfter(node.end, `)`)
          } else {
            scriptSetup.insertAfter(node.expression.end, useRouteNameTypeParam)
          }
        } else if (
          !isJs &&
          ts.isTypeQueryNode(node) &&
          ts.isIdentifier(node.exprName) &&
          node.exprName.text === 'useRoute' &&
          !node.typeArguments
        ) {
          // Without type arguments, `typeof useRoute` falls back to every route
          scriptSetup.insertAfter(node.exprName.end, useRouteNameTypeParam)
        } else if (
          !isJs &&
          isDefinePageCall(node) &&
          !node.typeArguments &&
          node.arguments.length === 1
        ) {
          // the file path narrows `params.path`, the component type checks `props`
          const props = getPropsOption(node)
          scriptSetup.insertAfter(
            node.expression.end,
            props && props.kind !== ts.SyntaxKind.FalseKeyword
              ? definePageWithPropsTypeParams
              : definePageTypeParams
          )
        } else if (
          hasPropsTrue &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'defineProps' &&
          !node.arguments.length
        ) {
          // `props: true` passes the route params as props
          const [typeArg] = node.typeArguments ?? []
          if (typeArg) {
            scriptSetup.insertBefore(
              typeArg.getStart(ast),
              `${routePropsType} & (`
            )
            scriptSetup.insertAfter(typeArg.end, `)`)
          } else {
            scriptSetup.insertAfter(node.expression.end, `<${routePropsType}>`)
            // the mapper reads the props of the component from the original call
            routeProps.push({ type: routePropsType })
          }
        } else {
          node.forEachChild(visit)
        }
      })
    },
    templateContext: () => [`{ $route: ${routeType} }`],
    props: () => routeProps,
  }

  function isDefinePageCall(node: ts.Node): node is ts.CallExpression {
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'definePage'
    )
  }

  /**
   * Returns the value of `props` in `definePage({ props })`.
   */
  function getPropsOption(
    definePageCall: ts.CallExpression
  ): ts.Expression | undefined {
    const [arg] = definePageCall.arguments
    if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined
    for (const prop of arg.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'props'
      ) {
        return prop.initializer
      }
    }
    return undefined
  }
}
