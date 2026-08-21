# Perita Mobile

Aplicación mobile-first de Perita V1.1.0 construida con Vite, React, TypeScript, Tailwind CSS y shadcn/ui. Funciona como PWA instalable en modo light y usa una base IndexedDB propia, aislada de la aplicación heredada.

## Arquitectura

```text
src/
├── app/          composición, navegación y carga diferida de secciones
├── components/   primitives shadcn y componentes visuales compartidos
├── features/     módulos verticales: presentación + casos de uso
├── domain/       contrato, invariantes y cálculos financieros puros
├── data/         IndexedDB, migraciones, transacciones y repositorios
├── lib/          utilidades técnicas sin reglas de negocio
└── pwa/          registro, instalación y actualización controlada
```

El flujo de dependencias es `presentación → aplicación → dominio/repositorios`. React no accede a IndexedDB ni modifica saldos; los cálculos, validaciones y reversiones viven en dominio/aplicación. `data/` implementa los contratos de repositorio y concentra la persistencia y las transacciones.

La base se abre con migraciones versionadas. El service worker solo cachea el shell y recursos estáticos: nunca abre, elimina ni reinicia IndexedDB. Backup e importación usan un contrato versionado independiente del esquema físico; una importación se valida antes del reemplazo transaccional.

Las secciones secundarias se cargan bajo demanda para mantener pequeño el arranque. Inicio y setup permanecen en el bundle inicial.

## Validación

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:pwa
```
