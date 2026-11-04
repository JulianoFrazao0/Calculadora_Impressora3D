'use strict';

/* ==========================================================================
   CONFIGURAÇÃO — COLE AQUI A URL DO GOOGLE DRIVE
   --------------------------------------------------------------------------
   Depois de criar o Apps Script (veja o passo a passo no arquivo
   2-google-drive/Code.gs), cole a URL do "app da Web" entre as aspas.
   Ela termina com /exec. Exemplo:
   const API_URL = 'https://script.google.com/macros/s/AKfycb.../exec';

   Enquanto estiver vazio, os orçamentos ficam salvos só neste navegador
   (modo de teste). Com a URL preenchida, todo mundo que abrir o site vê os
   mesmos orçamentos, e eles ficam numa Planilha Google no seu Drive.
   ========================================================================== */
const API_URL = '';

/* ==========================================================================
   CONSTANTES
   ========================================================================== */
const CHAVE_CONFIG = 'calculadora3d_settings';
const CHAVE_LOCAL = 'calculadora3d_orcamentos_local';
const QTD_ITENS = 10;
const POTENCIA_IMPRESSORA_W = 350;   // consumo médio da impressora
const HORAS_VIDA_UTIL = 2000;        // vida útil usada na depreciação
const MULTIPLICADORES = { amigo: 2, venda: 3, gringo: 6 };
const NOME_TIPO = { amigo: 'Amigo (2x)', venda: 'Venda (3x)', gringo: 'Gringo (6x)' };

const CONFIG_PADRAO = {
    custoFilamento: '150.00',
    pesoFilamento: '1000',
    precoImpressora: '5000.00',
    custoKwh: '1.17',
    precoModelagem: '200.00',
    tempoModelagem: '0',
    pesoDesconto1: '1000',
    percentualDesconto1: '3',
    pesoDesconto2: '3000',
    percentualDesconto2: '5',
    pesoDesconto3: '5000',
    percentualDesconto3: '10'
};
const CAMPOS_CONFIG = Object.keys(CONFIG_PADRAO);
const CAMPOS_DESCONTO = CAMPOS_CONFIG.filter(id => /Desconto/.test(id));

/* ==========================================================================
   ESTADO
   ========================================================================== */
let itens = [];               // itens do projeto atual
let idAtual = null;           // id do orçamento salvo que está aberto (ou null)
let listaOrcamentos = [];     // orçamentos vindos do Drive
let salvando = false;

/* ==========================================================================
   UTILITÁRIOS
   ========================================================================== */
const $ = id => document.getElementById(id);

function esc(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function formatarMoeda(valor) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor || 0);
}

function numero(id) {
    return parseFloat($(id).value) || 0;
}

/* "2026-09-18" -> "18/09/2026" (sem passar por Date, para não mudar o dia por fuso) */
function formatarDataISO(texto) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

function formatarDataHora(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('pt-BR');
}

function hojeISO() {
    return new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local
}

function estaVencido(r) {
    return r.status !== 'Pago' && !!r.vencimento && r.vencimento < hojeISO();
}

let timerToast;
function avisar(texto, tipo) {
    const t = $('toast');
    t.textContent = texto;
    t.className = 'toast ' + (tipo || 'ok') + ' show';
    clearTimeout(timerToast);
    timerToast = setTimeout(() => t.classList.remove('show'), tipo === 'erro' ? 6000 : 3500);
}

/* ==========================================================================
   CONFIGURAÇÕES (ficam no navegador de cada pessoa, como no original)
   ========================================================================== */
function lerConfiguracoes() {
    const cfg = {};
    CAMPOS_CONFIG.forEach(id => { cfg[id] = $(id).value; });
    return cfg;
}

function aplicarConfiguracoes(cfg) {
    CAMPOS_CONFIG.forEach(id => {
        if (cfg[id] !== undefined && cfg[id] !== null) $(id).value = cfg[id];
    });
}

function salvarConfiguracoes() {
    // Enquanto um orçamento salvo está aberto, as configurações pertencem a ele
    if (idAtual) return;
    try {
        localStorage.setItem(CHAVE_CONFIG, JSON.stringify(lerConfiguracoes()));
    } catch (e) { /* navegador bloqueou o armazenamento: segue sem salvar */ }
}

function carregarConfiguracoes() {
    let salvo = {};
    try { salvo = JSON.parse(localStorage.getItem(CHAVE_CONFIG)) || {}; } catch (e) { /* ignora */ }
    aplicarConfiguracoes({ ...CONFIG_PADRAO, ...salvo });
}

function atualizarExibicaoDescontos() {
    for (let n = 1; n <= 3; n++) {
        $('displayPeso' + n).textContent = $('pesoDesconto' + n).value;
        $('displayDesconto' + n).textContent = $('percentualDesconto' + n).value;
    }
}

/* ==========================================================================
   ITENS DO PROJETO
   ========================================================================== */
function criarItens() {
    itens = Array.from({ length: QTD_ITENS }, (_, i) => ({ nome: `Item ${i + 1}`, peso: 0, tempo: 0 }));
}

function renderizarItens() {
    $('itemsTable').innerHTML = itens.map((item, i) => `
        <tr>
            <td><input class="input" type="text" data-i="${i}" data-campo="nome" value="${esc(item.nome)}" aria-label="Nome do item ${i + 1}"></td>
            <td><input class="input" type="number" data-i="${i}" data-campo="peso" value="${esc(item.peso)}" min="0" step="0.1" aria-label="Peso do item ${i + 1} em gramas"></td>
            <td><input class="input" type="number" data-i="${i}" data-campo="tempo" value="${esc(item.tempo)}" min="0" step="1" aria-label="Tempo do item ${i + 1} em minutos"></td>
        </tr>
    `).join('');
}

/* ==========================================================================
   CÁLCULOS (mesma lógica da calculadora original)
   ========================================================================== */
function calcular() {
    const quantidade = Math.max(1, parseInt($('quantidadeProjeto').value) || 1);

    // Totais
    const pesoUnidade = itens.reduce((soma, it) => soma + it.peso, 0);
    const tempoUnidade = itens.reduce((soma, it) => soma + it.tempo, 0);
    const pesoProjeto = pesoUnidade * quantidade;
    const tempoProjeto = tempoUnidade * quantidade;

    // Custos
    const pesoFilamento = numero('pesoFilamento') || 1000;
    const material = (pesoProjeto / pesoFilamento) * numero('custoFilamento');
    const energia = (POTENCIA_IMPRESSORA_W / 1000) * (tempoProjeto / 60) * numero('custoKwh');
    const depreciacao = (tempoProjeto / 60) * (numero('precoImpressora') / HORAS_VIDA_UTIL);
    const modelagem = numero('tempoModelagem') * numero('precoModelagem');
    const custoSemModelagem = material + energia + depreciacao;
    const custoTotal = custoSemModelagem + modelagem;

    // Desconto por peso: vale a maior faixa atingida
    const faixas = [1, 2, 3]
        .map(n => ({ peso: numero('pesoDesconto' + n), desconto: numero('percentualDesconto' + n) }))
        .sort((a, b) => b.peso - a.peso);
    const faixa = faixas.find(f => f.peso > 0 && pesoProjeto >= f.peso);
    const percentualDesconto = faixa ? faixa.desconto : 0;

    // Preço por tipo de cliente (a modelagem não é multiplicada)
    const precos = {};
    Object.keys(MULTIPLICADORES).forEach(tipo => {
        const base = custoSemModelagem * MULTIPLICADORES[tipo] + modelagem;
        const total = base - base * (percentualDesconto / 100);
        precos[tipo] = { base, total, unitario: total / quantidade };
    });

    const tipo = $('tipoCliente').value;
    const escolhido = precos[tipo];

    return {
        quantidade, tipo,
        totais: { pesoUnidade, tempoUnidade, pesoProjeto, tempoProjeto },
        custos: { material, energia, depreciacao, modelagem, total: custoTotal },
        preco: {
            base: escolhido.base,
            percentualDesconto,
            desconto: escolhido.base - escolhido.total,
            final: escolhido.total,
            porTipo: precos
        }
    };
}

function atualizarTela() {
    const { totais, custos, preco } = calcular();

    $('totalPesoUnidade').textContent = `${totais.pesoUnidade.toFixed(1)}g`;
    $('totalTempoUnidade').textContent = `${totais.tempoUnidade.toFixed(0)}min`;
    $('totalPesoProjeto').textContent = `${totais.pesoProjeto.toFixed(1)}g`;
    $('totalTempoProjeto').textContent = `${totais.tempoProjeto.toFixed(0)}min`;

    $('custoMaterial').textContent = formatarMoeda(custos.material);
    $('custoEnergia').textContent = formatarMoeda(custos.energia);
    $('custoDepreciacao').textContent = formatarMoeda(custos.depreciacao);
    $('custoTotal').textContent = formatarMoeda(custos.total);

    const temModelagem = numero('tempoModelagem') > 0;
    $('custoModelagemDiv').classList.toggle('hidden', !temModelagem);
    $('custoModelagemTotal').textContent = formatarMoeda(custos.modelagem);

    $('valorVenda').textContent = formatarMoeda(preco.base);
    $('descontoDiv').classList.toggle('hidden', preco.percentualDesconto <= 0);
    $('percentualDesconto').textContent = preco.percentualDesconto;
    $('valorDesconto').textContent = formatarMoeda(preco.desconto);
    $('totalFinal').textContent = formatarMoeda(preco.final);

    $('precoUnitarioAmigo').textContent = formatarMoeda(preco.porTipo.amigo.unitario);
    $('precoTotalAmigo').textContent = formatarMoeda(preco.porTipo.amigo.total);
    $('precoUnitarioVenda').textContent = formatarMoeda(preco.porTipo.venda.unitario);
    $('precoTotalVenda').textContent = formatarMoeda(preco.porTipo.venda.total);
    $('precoUnitarioGringo').textContent = formatarMoeda(preco.porTipo.gringo.unitario);
    $('precoTotalGringo').textContent = formatarMoeda(preco.porTipo.gringo.total);
}

/* ==========================================================================
   ARMAZENAMENTO
   Duas opções com a mesma interface:
   - remoto: Google Drive (Apps Script + Planilha Google)  -> quando API_URL existe
   - local: localStorage do navegador                       -> modo de teste
   ========================================================================== */
const usaDrive = API_URL.trim() !== '';

async function chamarDrive(corpo) {
    const url = API_URL.trim();
    if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/[^/]+\/exec(\?|$)/.test(url)) {
        throw new Error('A URL colada em API_URL parece incorreta. Use a "URL do app da Web": ela começa com https://script.google.com/macros/s/ e termina com /exec (não é o endereço do editor).');
    }
    let resposta;
    try {
        if (corpo) {
            // text/plain evita a checagem CORS extra (preflight) que o Apps Script não responde
            resposta = await fetch(url, { method: 'POST', body: JSON.stringify(corpo) });
        } else {
            resposta = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=list&t=' + Date.now());
        }
    } catch (e) {
        throw new Error('Não deu para acessar o Google Drive. Confira: (1) a internet; (2) se a implantação do Apps Script está com acesso "Qualquer pessoa"; (3) se a URL em API_URL é a do app da Web e termina com /exec.');
    }

    let dados;
    try {
        dados = await resposta.json();
    } catch (e) {
        throw new Error('O Google não respondeu como esperado. Confira se a implantação do Apps Script está com acesso "Qualquer pessoa".');
    }
    if (!dados.ok) throw new Error(dados.error || 'Erro ao falar com o Google Drive.');
    return dados;
}

const armazenamentoDrive = {
    async listar() { return (await chamarDrive()).items; },
    async salvar(registro) { return (await chamarDrive({ action: 'save', item: registro })).item; },
    async mudarStatus(id, status) { await chamarDrive({ action: 'setStatus', id, status }); },
    async excluir(id) { await chamarDrive({ action: 'delete', id }); }
};

const armazenamentoLocal = {
    ler() {
        try { return JSON.parse(localStorage.getItem(CHAVE_LOCAL)) || []; } catch (e) { return []; }
    },
    gravar(lista) { localStorage.setItem(CHAVE_LOCAL, JSON.stringify(lista)); },
    async listar() { return this.ler(); },
    async salvar(registro) {
        const lista = this.ler();
        const agora = new Date().toISOString();
        const i = lista.findIndex(r => r.id === registro.id);
        if (i >= 0) {
            lista[i] = { ...lista[i], ...registro, atualizadoEm: agora };
            this.gravar(lista);
            return lista[i];
        }
        const novo = {
            ...registro,
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            criadoEm: agora,
            atualizadoEm: agora
        };
        lista.push(novo);
        this.gravar(lista);
        return novo;
    },
    async mudarStatus(id, status) {
        this.gravar(this.ler().map(r => r.id === id ? { ...r, status } : r));
    },
    async excluir(id) {
        this.gravar(this.ler().filter(r => r.id !== id));
    }
};

const armazenamento = usaDrive ? armazenamentoDrive : armazenamentoLocal;

/* ==========================================================================
   ORÇAMENTOS SALVOS: LISTA
   ========================================================================== */
function ordenarLista(lista) {
    return [...lista].sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

async function carregarLista(mostrarCarregando) {
    if (mostrarCarregando) $('savedEmpty').textContent = 'Carregando...';
    try {
        const registros = await armazenamento.listar();
        listaOrcamentos = ordenarLista(registros);
        $('avisoErro').classList.add('hidden');
        renderizarLista();
    } catch (e) {
        $('avisoErro').textContent = 'Não foi possível carregar os orçamentos. ' + e.message;
        $('avisoErro').classList.remove('hidden');
        if (!listaOrcamentos.length) $('savedEmpty').textContent = '';
    }
}

function plural(n, singular, plural) {
    return `${n} ${n === 1 ? singular : plural}`;
}

function somar(lista) {
    return lista.reduce((soma, r) => soma + (Number(r.totalFinal) || 0), 0);
}

function renderizarLista() {
    const termo = $('busca').value.trim().toLowerCase();
    const filtro = $('filtroStatus').value;

    // O resumo considera a busca por cliente; o filtro de status só afeta a tabela
    const buscados = listaOrcamentos.filter(r => String(r.cliente || '').toLowerCase().includes(termo));
    const visiveis = buscados.filter(r => filtro === 'todos' || r.status === filtro);

    const pendentes = buscados.filter(r => r.status !== 'Pago');
    const pagos = buscados.filter(r => r.status === 'Pago');
    const vencidos = pendentes.filter(estaVencido).length;

    $('totalReceber').textContent = formatarMoeda(somar(pendentes));
    $('pendentesTexto').textContent = `(${plural(pendentes.length, 'pendente', 'pendentes')}${vencidos ? ', ' + plural(vencidos, 'vencido', 'vencidos') : ''})`;
    $('totalRecebido').textContent = formatarMoeda(somar(pagos));
    $('pagosTexto').textContent = `(${plural(pagos.length, 'pago', 'pagos')})`;

    $('savedBody').innerHTML = visiveis.map(r => {
        const vencido = estaVencido(r);
        const badge = r.status === 'Pago'
            ? '<span class="badge badge-pago">Pago</span>'
            : vencido
                ? '<span class="badge badge-vencido">Vencido</span>'
                : '<span class="badge badge-pendente">Pendente</span>';
        const acaoStatus = r.status === 'Pago' ? 'Marcar como pendente' : 'Marcar como pago';
        return `
            <tr data-id="${esc(r.id)}" class="${r.id === idAtual ? 'aberto' : ''}">
                <td><button type="button" class="link-btn" data-acao="abrir" title="Abrir na calculadora">${esc(r.cliente || 'Sem nome')}</button></td>
                <td>${formatarDataHora(r.criadoEm)}</td>
                <td>${esc(NOME_TIPO[r.tipoCliente] || r.tipoCliente)}</td>
                <td class="num">${formatarMoeda(r.totalFinal)}</td>
                <td>${formatarDataISO(r.vencimento)}</td>
                <td>${badge}</td>
                <td class="acoes">
                    <button type="button" class="btn btn-secondary btn-sm" data-acao="status">${acaoStatus}</button>
                    <button type="button" class="btn btn-danger btn-sm" data-acao="excluir">Excluir</button>
                </td>
            </tr>`;
    }).join('');

    if (!listaOrcamentos.length) {
        $('savedEmpty').textContent = 'Nenhum orçamento salvo ainda. Preencha os itens, digite o cliente e clique em "Salvar orçamento".';
    } else if (!visiveis.length) {
        $('savedEmpty').textContent = 'Nenhum orçamento encontrado com essa busca.';
    } else {
        $('savedEmpty').textContent = '';
    }
}

/* ==========================================================================
   ORÇAMENTOS SALVOS: AÇÕES
   ========================================================================== */
function atualizarEstadoEdicao() {
    const editando = !!idAtual;
    $('saveTitle').textContent = editando ? 'Editando orçamento salvo' : 'Salvar orçamento';
    $('btnSalvar').textContent = editando ? 'Atualizar orçamento' : 'Salvar orçamento';
    $('btnNovo').classList.toggle('hidden', !editando);
    $('settingsHint').classList.toggle('hidden', !editando);
}

function ocupado(sim) {
    salvando = sim;
    $('btnSalvar').disabled = sim;
    $('btnAtualizar').disabled = sim;
}

async function salvarOrcamento() {
    if (salvando) return;

    const cliente = $('cliente').value.trim();
    if (!cliente) {
        avisar('Digite o nome do cliente para salvar.', 'erro');
        $('cliente').focus();
        return;
    }

    const { quantidade, tipo, totais, preco } = calcular();
    if (totais.pesoProjeto <= 0 && totais.tempoProjeto <= 0) {
        avisar('Preencha o peso ou o tempo de pelo menos um item antes de salvar.', 'erro');
        return;
    }

    const registro = {
        id: idAtual || undefined,
        cliente,
        tipoCliente: tipo,
        quantidade,
        pesoTotal: Math.round(totais.pesoProjeto * 10) / 10,
        tempoTotal: Math.round(totais.tempoProjeto),
        totalFinal: Math.round(preco.final * 100) / 100,
        status: $('statusPagamento').value,
        vencimento: $('vencimento').value,
        dados: {
            items: itens.map(i => ({ nome: i.nome, peso: i.peso, tempo: i.tempo })),
            settings: lerConfiguracoes(),
            quantidadeProjeto: quantidade,
            tipoCliente: tipo
        }
    };

    const eraEdicao = !!idAtual;
    ocupado(true);
    $('btnSalvar').textContent = 'Salvando...';
    try {
        const salvo = await armazenamento.salvar(registro);
        idAtual = salvo.id;
        avisar(eraEdicao ? 'Orçamento atualizado.' : 'Orçamento salvo.', 'ok');
        await carregarLista();
    } catch (e) {
        avisar('Não foi possível salvar. ' + e.message, 'erro');
    } finally {
        ocupado(false);
        atualizarEstadoEdicao();
        renderizarLista();
    }
}

function abrirOrcamento(id) {
    const r = listaOrcamentos.find(x => x.id === id);
    if (!r) return;
    const d = r.dados || {};

    criarItens();
    (Array.isArray(d.items) ? d.items : []).slice(0, QTD_ITENS).forEach((it, i) => {
        itens[i] = {
            nome: String(it.nome ?? `Item ${i + 1}`),
            peso: Number(it.peso) || 0,
            tempo: Number(it.tempo) || 0
        };
    });

    aplicarConfiguracoes({ ...CONFIG_PADRAO, ...(d.settings || {}) });
    $('quantidadeProjeto').value = d.quantidadeProjeto || r.quantidade || 1;
    $('tipoCliente').value = MULTIPLICADORES[r.tipoCliente] ? r.tipoCliente : 'amigo';
    $('cliente').value = r.cliente || '';
    $('vencimento').value = r.vencimento || '';
    $('statusPagamento').value = r.status === 'Pago' ? 'Pago' : 'Pendente';

    idAtual = r.id;
    renderizarItens();
    atualizarExibicaoDescontos();
    atualizarTela();
    atualizarEstadoEdicao();
    renderizarLista();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    avisar(`Orçamento de ${r.cliente || 'cliente'} aberto.`, 'ok');
}

function novoOrcamento() {
    idAtual = null;
    criarItens();
    carregarConfiguracoes();
    $('quantidadeProjeto').value = 1;
    $('cliente').value = '';
    $('vencimento').value = '';
    $('statusPagamento').value = 'Pendente';
    renderizarItens();
    atualizarExibicaoDescontos();
    atualizarTela();
    atualizarEstadoEdicao();
    renderizarLista();
}

async function alternarStatus(id) {
    const r = listaOrcamentos.find(x => x.id === id);
    if (!r || salvando) return;
    const novo = r.status === 'Pago' ? 'Pendente' : 'Pago';
    ocupado(true);
    try {
        await armazenamento.mudarStatus(id, novo);
        if (id === idAtual) $('statusPagamento').value = novo;
        avisar(novo === 'Pago' ? 'Marcado como pago.' : 'Marcado como pendente.', 'ok');
        await carregarLista();
    } catch (e) {
        avisar('Não foi possível atualizar. ' + e.message, 'erro');
    } finally {
        ocupado(false);
    }
}

async function excluirOrcamento(id) {
    const r = listaOrcamentos.find(x => x.id === id);
    if (!r || salvando) return;
    if (!confirm(`Excluir o orçamento de ${r.cliente || 'cliente'}? Isso não pode ser desfeito.`)) return;
    ocupado(true);
    try {
        await armazenamento.excluir(id);
        if (id === idAtual) { idAtual = null; atualizarEstadoEdicao(); }
        avisar('Orçamento excluído.', 'ok');
        await carregarLista();
    } catch (e) {
        avisar('Não foi possível excluir. ' + e.message, 'erro');
    } finally {
        ocupado(false);
    }
}

/* ==========================================================================
   EVENTOS
   ========================================================================== */
function configurarEventos() {
    // Painel de configurações
    $('settingsToggle').addEventListener('click', () => {
        const painel = $('settingsPanel');
        painel.classList.toggle('hidden');
        $('settingsToggle').setAttribute('aria-expanded', String(!painel.classList.contains('hidden')));
    });

    CAMPOS_CONFIG.forEach(id => {
        $(id).addEventListener('input', () => {
            if (CAMPOS_DESCONTO.includes(id)) atualizarExibicaoDescontos();
            salvarConfiguracoes();
            atualizarTela();
        });
    });

    $('quantidadeProjeto').addEventListener('input', atualizarTela);
    $('tipoCliente').addEventListener('change', atualizarTela);

    // Tabela de itens (um único ouvinte para todos os campos)
    $('itemsTable').addEventListener('input', e => {
        const campo = e.target.dataset.campo;
        if (!campo) return;
        const item = itens[Number(e.target.dataset.i)];
        if (campo === 'nome') {
            item.nome = e.target.value;
        } else {
            item[campo] = Math.max(0, parseFloat(e.target.value) || 0);
            atualizarTela();
        }
    });

    // Salvar / novo
    $('btnSalvar').addEventListener('click', salvarOrcamento);
    $('btnNovo').addEventListener('click', novoOrcamento);
    $('cliente').addEventListener('keydown', e => { if (e.key === 'Enter') salvarOrcamento(); });

    // Lista de orçamentos: clicar na linha abre; os botões fazem suas ações
    $('savedBody').addEventListener('click', e => {
        const linha = e.target.closest('tr[data-id]');
        if (!linha) return;
        const botao = e.target.closest('button[data-acao]');
        const acao = botao ? botao.dataset.acao : 'abrir';
        const id = linha.dataset.id;
        if (acao === 'abrir') abrirOrcamento(id);
        else if (acao === 'status') alternarStatus(id);
        else if (acao === 'excluir') excluirOrcamento(id);
    });

    $('busca').addEventListener('input', renderizarLista);
    $('filtroStatus').addEventListener('change', renderizarLista);
    $('btnAtualizar').addEventListener('click', () => carregarLista(true));

    // Ao voltar para a aba, puxa a lista mais recente (outras pessoas podem ter salvado)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !salvando) carregarLista();
    });
}

function mostrarAvisoDeModo() {
    if (usaDrive) return;
    const aviso = $('avisoModo');
    aviso.textContent = 'Modo de teste: os orçamentos estão sendo salvos só neste navegador. Para todo mundo ver os mesmos orçamentos, coloque a URL do Google Drive em API_URL no começo do arquivo script.js.';
    aviso.classList.remove('hidden');
}

/* ==========================================================================
   INÍCIO
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    criarItens();
    carregarConfiguracoes();
    renderizarItens();
    configurarEventos();
    atualizarExibicaoDescontos();
    atualizarTela();
    atualizarEstadoEdicao();
    mostrarAvisoDeModo();
    carregarLista(true);
});
