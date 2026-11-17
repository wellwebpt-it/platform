# WellWeb — pacote de referências para a Fase 3

Este pacote reúne os protótipos históricos recuperados e a estrutura de pastas proposta
para o repositório `wellweb-foundation`.

**Importante:** não contém uma cópia da aplicação atual (`src`, `public`, migrations,
configuração ou dependências). Esses ficheiros já existem no teu repositório local e
não tenho acesso direto ao filesystem do WSL. Não substituas as pastas atuais `src`
ou `public` por estas pastas de referência.

## Estrutura de referência

```text
wellweb-foundation/
├── design/
│   └── reference/
│       ├── wellweb_demo_v3.html
│       └── wellweb_demo_v4.html
├── img/
│   └── wellweb-logo.png
├── public/
│   └── brand/
└── src/
```

## Logótipo oficial

O logótipo oficial já está no teu repositório local em:

`img/wellweb-logo.png`

Caminho UNC indicado:
`\\wsl.localhost\Ubuntu\home\wellweb\wellweb-foundation\img\wellweb-logo.png`

O Codex deve verificar esse ficheiro e utilizá-lo como fonte oficial. Não redesenhar
a flor, não recriar o lettering e não substituir por um ícone. Manter o original
intacto; criar apenas derivados web quando necessário, guardando-os em `public/brand/`.

## Como instalar as referências

A partir da raiz do repositório WSL, copia a pasta `design` deste pacote para o
repositório. Mantém intactos os diretórios `src`, `public`, `supabase` e restantes
ficheiros existentes.

## Instrução de utilização

Antes de qualquer implementação da Fase 3, o Codex deve abrir e analisar integralmente
os dois HTML, incluindo CSS e JavaScript embutidos, e comparar a experiência com a
aplicação React atual.

Os protótipos são referências de produto e design, não código para substituir
diretamente a aplicação. Distinguir sempre:
- referência visual/UX;
- comportamento demonstrativo com dados fictícios;
- funcionalidades já implementadas e persistidas em Supabase;
- funcionalidades ainda por construir.

## Nota sobre v1/v2

Este pacote inclui v3 e v4, recuperados com sucesso. As versões `wellweb_demo.html`
e `wellweb_demo_v2.html` não foram incluídas nesta exportação.
