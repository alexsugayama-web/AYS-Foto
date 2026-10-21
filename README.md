# Foto 2×2

Ferramenta web que transforma uma foto comum em uma foto de rosto 2 × 2 polegadas (5,1 × 5,1 cm), no padrão de visto e passaporte dos Estados Unidos. O arquivo sai em JPEG de 600 × 600 pixels, com 300 dpi e menos de 240 kB, pronto para o formulário DS-160.

Tudo roda no navegador de quem usa: a foto não é enviada a nenhum servidor. É um site estático, sem etapa de build, que pode ser publicado de graça na Vercel.

## O que a ferramenta faz

- Encontra o rosto e enquadra sozinha: a cabeça, do alto do cabelo ao queixo, ocupa 60% da altura, e os olhos ficam a 62,5% da base. As faixas oficiais são de 50% a 69% para a cabeça e de 56% a 69% para os olhos.
- Nivela a cabeça pela linha dos olhos.
- Troca o fundo por branco quando o original não é claro. A opção pode ser desligada.
- Mostra réguas em polegadas e milímetros, com guias para os olhos, o topo da cabeça e o queixo, e permite ajustar zoom, posição e inclinação (mouse, toque, roda do mouse ou teclado).
- Confere as medidas em tempo real e avisa sobre olhos fechados, sorriso aberto, rosto virado, resolução baixa, mais de uma pessoa e foto cortada.
- Se o detector automático não carregar, continua funcionando no modo manual, com as guias.

## Publicar no GitHub e na Vercel

### Pelo navegador, sem instalar nada

1. Em [github.com/new](https://github.com/new), crie um repositório (por exemplo, `foto-2x2`). Pode ser público ou privado.
2. Na página do repositório vazio, clique em **uploading an existing file** e arraste todo o conteúdo desta pasta: `index.html`, `styles.css`, `favicon.svg`, `vercel.json`, `README.md` e as pastas `js` e `fonts`. Clique em **Commit changes**.
3. Em [vercel.com/new](https://vercel.com/new), importe o repositório. A Vercel reconhece o projeto como site estático (preset **Other**); não é preciso preencher comando de build nem pasta de saída. Clique em **Deploy**.
4. Em cerca de um minuto aparece o endereço do site, algo como `foto-2x2.vercel.app`. A cada novo commit no GitHub a Vercel publica a versão atualizada.

### Pela linha de comando

```bash
cd foto-2x2
git init
git add .
git commit -m "Foto 2x2"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/foto-2x2.git
git push -u origin main
```

Depois importe o repositório na Vercel como no passo 3, ou rode `npx vercel` dentro da pasta.

## Testar no computador

Os módulos JavaScript não funcionam abrindo o `index.html` direto do disco. Rode um servidor local na pasta e abra o endereço indicado:

```bash
npx serve .
# ou
python3 -m http.server 8000   # http://localhost:8000
```

## Como funciona

A detecção usa duas tarefas do [MediaPipe](https://ai.google.dev/edge/mediapipe), do Google, executadas em WebAssembly: o Face Landmarker, que marca 478 pontos do rosto (íris, queixo, testa, contorno) e indica olhos fechados e sorriso, e o Image Segmenter, que separa pessoa e fundo. A biblioteca `@mediapipe/tasks-vision` 1.1.1 vem do jsDelivr e os modelos vêm do Google Cloud Storage. São até cerca de 18 MB baixados na primeira visita e guardados em cache pelo navegador; nas visitas seguintes o carregamento é rápido.

O topo da cabeça é medido pela segmentação: a partir da testa, a ferramenta sobe pelas colunas do rosto até onde termina o cabelo. Se a foto estiver cortada em cima, a altura é estimada e a lista de conferência avisa.

Para o fundo branco, a máscara do segmentador é refinada com um filtro guiado pelas cores da própria foto, o que preserva orelhas, contorno do cabelo e ombros sem deixar manchas do fundo antigo.

O arquivo final é gerado com redução em etapas para manter a nitidez, comprimido até ficar abaixo de 240 kB e gravado com 300 dpi no cabeçalho JFIF, para sair com 2 × 2 polegadas quando impresso em tamanho real.

## Ajustar as regras

Os limites ficam no objeto `SPEC`, no início de `js/photo.js`: tamanho em pixels, dpi, limite de bytes, faixas da cabeça e dos olhos e os alvos do enquadramento automático.

## Arquivos

| Arquivo | Conteúdo |
| --- | --- |
| `index.html`, `styles.css` | Página e estilos |
| `js/app.js` | Interface, interação e lista de conferência |
| `js/photo.js` | Regras, geometria do enquadramento, renderização e JPEG |
| `js/vision.js` | Carregamento do MediaPipe, detecção do rosto e do topo da cabeça |
| `js/mask.js` | Recorte do fundo com borda refinada |
| `fonts/` | Fonte Public Sans (licença OFL, em `fonts/OFL.txt`) |
| `vercel.json` | Cabeçalhos de segurança e cache da fonte |

## Requisitos usados

Página de requisitos de foto e modelo de composição do Departamento de Estado dos EUA ([travel.state.gov](https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/photos.html)): foto quadrada de 600 a 1200 pixels, JPEG de até 240 kB, cabeça entre 50% e 69% da altura, olhos entre 56% e 69% a partir da base, fundo branco ou quase branco, expressão neutra, olhos abertos e sem óculos. A ferramenta é independente e a decisão final sobre a foto é do consulado.

## Licenças de terceiros

MediaPipe Tasks Vision: Apache 2.0. Public Sans: SIL Open Font License 1.1.
