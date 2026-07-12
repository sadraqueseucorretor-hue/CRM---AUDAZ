// ====================================================================
        // 1. DATABASE E CONSTANTES GERAIS
        // ====================================================================
        // ====================================================================
        // SUPABASE — banco de dados na nuvem
        // ====================================================================
        const SUPABASE_URL = 'https://litiosaaclnqxxehhfvj.supabase.co';
        const SUPABASE_KEY = 'sb_publishable_6x0C0Y8C4J1qpcwFU1FFIA_6I-8NiIZ';
        const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

        // Flag para distinguir logout voluntário ("Sair") de sessão expirada
        let _logoutIntencional = false;

        // Listener de estado da autenticação
        _sb.auth.onAuthStateChange((event) => {
            // Usuário voltou do link de redefinição de senha por e-mail
            if(event === 'PASSWORD_RECOVERY') {
                try { document.getElementById('app-login').classList.remove('hidden'); document.getElementById('app-login').classList.remove('opacity-0'); } catch(_) {}
                try { document.getElementById('app-crm').classList.add('hidden'); } catch(_) {}
                if(typeof openModal === 'function') openModal('modal-nova-senha');
            }
            // Sessão encerrada (token expirado ou refresh falhou) — só age se NÃO foi logout voluntário
            if(event === 'SIGNED_OUT' && !_logoutIntencional && currentUser) {
                localStorage.removeItem(DB_KEYS.SESSION);
                localStorage.removeItem(DB_KEYS.LOGGED_USER);
                currentUser = null;
                if(typeof showLogin === 'function') showLogin();
                setTimeout(() => {
                    if(typeof showToast === 'function')
                        showToast('Sua sessão expirou. Faça login novamente.', 'warning');
                }, 400);
            }
        });

        async function dbGet(key) {
            const { data, error } = await _sb.from('crm_storage').select('value').eq('key', key).maybeSingle();
            if (error || !data) return null;
            return JSON.stringify(data.value);
        }

        async function dbSet(key, valueStr) {
            const value = JSON.parse(valueStr);
            const { error } = await _sb.from('crm_storage').upsert({ key, value }, { onConflict: 'key' });
            if (error) console.error('Supabase save error:', error.message);
        }

        async function dbDelete(key) {
            await _sb.from('crm_storage').delete().eq('key', key);
        }

        // ====================================================================
        // CAMADA MULTI-USUÁRIO: 1 linha por lead / 1 linha por usuário
        // ====================================================================
        // Snapshots para detectar o que mudou (salva só o que mudou)
        let _leadsSnapshot = {};   // id -> JSON string da última versão salva
        let _usersSnapshot = {};   // id -> JSON string da última versão salva

        function _rebuildSnapshot(arr) {
            const snap = {};
            arr.forEach(item => { snap[item.id] = JSON.stringify(item); });
            return snap;
        }

        // Carrega todos os leads (cada um é uma linha)
        async function loadLeadsFromDB() {
            const { data, error } = await _sb.from('leads').select('data').limit(20000);
            if(error) { console.error('Erro ao carregar leads:', error.message); return null; }
            return data.map(r => r.data);
        }
        async function loadUsersFromDB() {
            const { data, error } = await _sb.from('users').select('data').limit(20000);
            if(error) { console.error('Erro ao carregar usuários:', error.message); return null; }
            return data.map(r => r.data);
        }

        // Salva no banco APENAS os leads que mudaram + remove os excluídos
        async function persistLeads() {
            const changed = [];
            const currentIds = new Set();
            DB.leads.forEach(l => {
                currentIds.add(l.id);
                const json = JSON.stringify(l);
                if(_leadsSnapshot[l.id] !== json) {
                    changed.push({ id: l.id, data: l, updated_at: new Date().toISOString() });
                    _leadsSnapshot[l.id] = json;
                }
            });
            const deletedIds = Object.keys(_leadsSnapshot).filter(id => !currentIds.has(id));
            deletedIds.forEach(id => delete _leadsSnapshot[id]);

            if(changed.length) {
                const { error } = await _sb.from('leads').upsert(changed, { onConflict: 'id' });
                if(error) { console.error('Erro ao salvar leads:', error.message); throw error; }
            }
            if(deletedIds.length) {
                await _sb.from('leads').delete().in('id', deletedIds);
            }
        }

        // Salva no banco APENAS os usuários que mudaram + remove os excluídos
        async function persistUsers() {
            const changed = [];
            const currentIds = new Set();
            DB.users.forEach(u => {
                currentIds.add(u.id);
                const json = JSON.stringify(u);
                if(_usersSnapshot[u.id] !== json) {
                    changed.push({ id: u.id, data: u });
                    _usersSnapshot[u.id] = json;
                }
            });
            const deletedIds = Object.keys(_usersSnapshot).filter(id => !currentIds.has(id));
            deletedIds.forEach(id => delete _usersSnapshot[id]);

            if(changed.length) {
                const { error } = await _sb.from('users').upsert(changed, { onConflict: 'id' });
                if(error) { console.error('Erro ao salvar usuários:', error.message); throw error; }
            }
            if(deletedIds.length) {
                await _sb.from('users').delete().in('id', deletedIds);
            }
        }

        // ====================================================================
        // SINCRONIZAÇÃO EM TEMPO REAL (Realtime)
        // ====================================================================
        let _realtimeChannel = null;
        let _refreshTimer = null;

        function refreshCurrentView() {
            // Atualiza a tela atual sem perder o que o usuário está fazendo
            clearTimeout(_refreshTimer);
            _refreshTimer = setTimeout(() => {
                updateNavCounters();
                if(currentView === 'dashboard') renderDashboard();
                else if(['leads','analise','financeiro'].includes(currentView)) {
                    // Não re-renderiza se há um modal de lead aberto (evita atrapalhar edição)
                    const modalOpen = !document.getElementById('modal-lead-details')?.classList.contains('hidden');
                    if(!modalOpen) renderKanban(currentPipeline);
                }
                else if(currentView === 'distribuir') renderDistribuir();
                else if(currentView === 'cancelados') renderCancelados();
                else if(currentView === 'users') renderUsersTable();
            }, 300);
        }

        function setupRealtime() {
            if(_realtimeChannel) { _sb.removeChannel(_realtimeChannel); }

            _realtimeChannel = _sb.channel('crm-changes')
                // Mudanças na tabela de LEADS
                .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => {
                    if(payload.eventType === 'DELETE') {
                        const id = payload.old?.id;
                        if(id) {
                            DB.leads = DB.leads.filter(l => l.id !== id);
                            delete _leadsSnapshot[id];
                        }
                    } else {
                        const lead = payload.new?.data;
                        if(lead && lead.id) {
                            const idx = DB.leads.findIndex(l => l.id === lead.id);
                            if(idx !== -1) DB.leads[idx] = lead;
                            else DB.leads.push(lead);
                            // Atualiza snapshot para não re-salvar essa mudança vinda de fora
                            _leadsSnapshot[lead.id] = JSON.stringify(lead);
                        }
                    }
                    refreshCurrentView();
                })
                // Mudanças na tabela de USUÁRIOS
                .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, (payload) => {
                    if(payload.eventType === 'DELETE') {
                        const id = payload.old?.id;
                        if(id) {
                            DB.users = DB.users.filter(u => u.id !== id);
                            delete _usersSnapshot[id];
                        }
                    } else {
                        const user = payload.new?.data;
                        if(user && user.id) {
                            const idx = DB.users.findIndex(u => u.id === user.id);
                            if(idx !== -1) DB.users[idx] = user;
                            else DB.users.push(user);
                            _usersSnapshot[user.id] = JSON.stringify(user);
                        }
                    }
                    if(currentView === 'users') refreshCurrentView();
                    populateBrokerDropdowns();
                })
                .subscribe();
        }

        const DB_KEYS = {
            USERS: 'audaz_users', LEADS: 'audaz_leads', SESSION: 'audaz_session',
            LOGGED_USER: 'audaz_logged_user', LAST_PAGE: 'audaz_last_page',
            NOTIFICATIONS: 'audaz_notifications', PIPELINES: 'audaz_pipelines', LISTAS: 'audaz_listas',
            SHEETS: 'audaz_sheets_url', CONFIG: 'audaz_config', SEEDED: 'audaz_seeded'
        };

        const PIPELINES_DEFAULT = {
            leads: [
                { id: 'aguardando', title: 'Aguardando Contato', color: 'border-l-slate-400' },
                { id: 'tratativa', title: 'Em Tratativa', color: 'border-l-yellow-400' },
                { id: 'hot', title: 'Hot Lead', color: 'border-l-orange-500' },
                { id: 'visita', title: 'Visita Agendada', color: 'border-l-purple-400' },
                { id: 'compareceu', title: 'Compareceu', color: 'border-l-green-400' },
                { id: 'doc-recebida', title: 'Doc. Recebida', color: 'border-l-teal-400' }
            ],
            analise: [
                { id: 'analise-pendente', title: 'Análise Pendente', color: 'border-l-slate-400' },
                { id: 'em-analise', title: 'Em Análise', color: 'border-l-yellow-400' },
                { id: 'com-pendencia', title: 'Com Pendência', color: 'border-l-orange-500' },
                { id: 'aprovado', title: 'Aprovado', color: 'border-l-green-500' },
                { id: 'reprovado', title: 'Reprovado', color: 'border-l-red-500' },
                { id: 'bacen', title: 'BACEN', color: 'border-l-purple-500' }
            ],
            financeiro: [
                { id: 'venda-gerada', title: 'Venda Gerada', color: 'border-l-blue-400' },
                { id: 'assinatura', title: 'Assinatura', color: 'border-l-purple-400' },
                { id: 'entrada-pendente', title: 'Ent. Pendente', color: 'border-l-orange-400' },
                { id: 'entrada-parcial', title: 'Ent. Parcial', color: 'border-l-yellow-400' },
                { id: 'quitado', title: 'Quitado', color: 'border-l-green-400' },
                { id: 'repasse', title: 'Repasse', color: 'border-l-indigo-400' },
                { id: 'comissao', title: 'Comissão', color: 'border-l-emerald-400' },
                { id: 'pos-venda', title: 'Pós-venda', color: 'border-l-pink-400' },
                { id: 'recebido-integral', title: 'Recebido Integral', color: 'border-l-blue-400' }
            ],
            cancelados: [
                { id: 'cancelado', title: 'Cancelado', color: 'border-l-red-500' }
            ]
        };

        let PIPELINES = JSON.parse(JSON.stringify(PIPELINES_DEFAULT));

        // Listas gerenciáveis pelo Diretor (Construtoras e Empreendimentos)
        let LISTAS = { construtoras: [], empreendimentos: [] };

        // Configurações gerais (Diretor): % da Nota Fiscal aplicado sobre a comissão
        let CONFIG = { percentualNota: 0, mesesComerciais: [] };

        const DOC_CHECKLIST_ITEMS = [
            { id: 'rg', label: 'RG / CNH' }, { id: 'cpf', label: 'CPF' }, { id: 'comp_residencia', label: 'Comp. Residência' },
            { id: 'estado_civil', label: 'Estado Civil' }, { id: 'holerite', label: 'Holerites (3 últ)' }, { id: 'extrato', label: 'Extrato Bancário' },
            { id: 'fgts', label: 'Extrato FGTS' }, { id: 'irpf', label: 'IRPF' }, { id: 'cnis', label: 'CNIS' }, { id: 'carteira_trab', label: 'Carteira de Trabalho' }
        ];

        let DB = { users: [], leads: [], notifications: [] };
        let currentUser = null;
        let currentView = 'dashboard';
        let currentPipeline = 'leads';
        let autoSaveTimeout = null;
        let charts = { funnel: null, origin: null };

        function generateId() { return Math.random().toString(36).substr(2, 9); }
        function nextNumId() {
            let max = 0;
            DB.leads.forEach(l => { if(typeof l.numId === 'number' && l.numId > max) max = l.numId; });
            return max + 1;
        }
        function formatNumId(n) { return '#' + String(n || 0).padStart(4, '0'); }

        // ====================================================================
        // INTEGRAÇÃO COM GOOGLE SHEETS (planilha de análises)
        // ====================================================================
        // Link do robô do Google (configurável pelo Diretor no Perfil)
        let SHEETS_URL = 'https://script.google.com/macros/s/AKfycbw6grA_LjvIisXi3PYKCl3O0r5qLYDO54IMcNdVXNeqTNwgbtpy0_oDcTzbIglcm8LGiA/exec';
        const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

        function leadSheetId(lead) {
            return lead.numId ? formatNumId(lead.numId) : lead.id;
        }

        // Calcula o status atual do lead conforme o pipeline/etapa
        const STATUS_ANALISE_MAP = {
            'aprovado': 'Aprovado', 'reprovado': 'Reprovado', 'com-pendencia': 'Pendente',
            'em-analise': 'Em Análise', 'analise-pendente': 'Análise Pendente', 'bacen': 'BACEN'
        };
        // Resultado da Análise de Crédito (Aprovado/Reprovado/Pendente...) — fica registrado no lead
        function resultadoAnalise(lead) {
            if(lead.pipeline === 'analise') {
                const stage = PIPELINES.analise.find(s => s.id === lead.stageId);
                const title = stage ? stage.title : '';
                // Se a etapa é personalizada OU foi renomeada em relação ao padrão,
                // usa o NOME ATUAL da etapa (evita traduzir, ex., "Aprovado Stand-By" como "BACEN").
                const def = (PIPELINES_DEFAULT.analise || []).find(s => s.id === lead.stageId);
                if(stage && (!def || def.title !== title)) return title;
                // Etapa padrão intacta: usa o rótulo canônico (mantém compatibilidade com BI/relatórios)
                return STATUS_ANALISE_MAP[lead.stageId] || title || 'Em Análise';
            }
            // Fora da análise: mantém o último resultado registrado
            return lead.analiseResult || '';
        }
        // Situação Atual (onde o negócio está agora)
        function situacaoAtual(lead) {
            if(lead.pipeline === 'cancelados') return 'Cancelado';
            if(lead.pipeline === 'financeiro') {
                const etapa = PIPELINES.financeiro.find(s => s.id === lead.stageId)?.title || '';
                return 'Ganho' + (etapa ? ' - ' + etapa : '');
            }
            if(lead.pipeline === 'analise') return 'Em Análise';
            if(lead.pipeline === 'leads') return 'Em Atendimento';
            return lead.pipeline;
        }

        // Normaliza várias formas de data (Date, "YYYY-MM-DD", "DD/MM/YYYY") em Date à meia-noite
        function _parseDataQualquer(d) {
            if(!d) return null;
            if(d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const s = String(d).trim();
            let m;
            if((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return new Date(+m[1], +m[2]-1, +m[3]);
            if((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) return new Date(+m[3], +m[2]-1, +m[1]);
            const dt = new Date(s);
            return isNaN(dt.getTime()) ? null : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
        }

        // Rótulo do MÊS COMERCIAL (ex.: "Junho/2026") em que a data cai.
        // Usa os períodos cadastrados pelo Diretor; se nenhum contém a data, cai no mês do calendário.
        function labelMesComercial(dateInput) {
            const dt = _parseDataQualquer(dateInput);
            if(!dt) return '';
            const periodos = CONFIG.mesesComerciais || [];
            for(const p of periodos) {
                const ini = _parseDataQualquer(p.inicio);
                const fim = _parseDataQualquer(p.fim);
                if(ini && fim && dt >= ini && dt <= fim) return p.ref;
            }
            return MESES_PT[dt.getMonth()] + '/' + dt.getFullYear();
        }

        // Converte "DD/MM/YYYY" em "Mês/AAAA" — agora respeita o mês comercial
        function mesRefDeDataBR(d) {
            if(!d) return '';
            return labelMesComercial(d);
        }

        // Data e mês do Ganho (a partir da data da venda)
        function dadosGanho(lead) {
            if(lead.pipeline !== 'financeiro') return { data: '', mes: '' };
            const sd = lead.saleDate || new Date().toISOString().split('T')[0];
            const p = sd.split('-'); // YYYY-MM-DD
            if(p.length === 3) {
                return { data: p[2] + '/' + p[1] + '/' + p[0], mes: labelMesComercial(sd) };
            }
            return { data: '', mes: '' };
        }

        // Envia/atualiza a linha completa do lead na planilha (sempre busca pelo ID)
        async function sincronizarPlanilha(lead) {
            if(!lead) return;
            const tracked = ['analise','financeiro'].includes(lead.pipeline);
            // Sincroniza se o lead está em análise/financeiro OU se já existe na planilha
            // (assim edições de nome/corretor/etc. e saída do ganho também atualizam)
            if(!tracked && !lead.naPlanilha) return;
            // Registra no lead o último resultado da análise (persiste após sair da análise)
            if(lead.pipeline === 'analise') lead.analiseResult = resultadoAnalise(lead);
            const ehFin = lead.pipeline === 'financeiro';
            const com = ehFin ? calcularComissoes(lead.vgv || 0, lead.commissionPctTotal || 0, lead.commissionPctCorretor || 0, lead.commissionPctGerente || 0) : null;
            const ganho = dadosGanho(lead);
            // Recebimentos de comissão
            const recs = (ehFin && lead.recebimentos) ? lead.recebimentos : [];
            const recCorr = recs.filter(r => r.tipo === 'Corretor').reduce((s,r) => s + (r.valor||0), 0);
            const recGer = recs.filter(r => r.tipo === 'Gerente').reduce((s,r) => s + (r.valor||0), 0);
            const totalRecebido = recCorr + recGer;
            const totalComissaoPagar = com ? (com.corretor + com.gerente) : 0;
            const faltaReceber = Math.max(0, totalComissaoPagar - totalRecebido);
            const ultimoRec = recs.length ? recs[recs.length-1] : null;
            const mesRec = ultimoRec ? mesRefDeDataBR(ultimoRec.data) : '';
            const detalheRec = recs.map(r => `${r.tipo} ${formatCurrency(r.valor)} (${r.data||''})`).join('; ');
            // Bônus (agora é uma LISTA — soma os totais para a planilha)
            const temBonus = ehFin && lead.temBonus === 'Sim';
            const bonusList = temBonus ? _bonusesDoLead(lead) : [];
            let bonusTotal = 0, bonusLiquido = 0, bonusRecebido = 0;
            bonusList.forEach(b => {
                const v = b.valor || 0, pct = b.pctNota || 0;
                bonusTotal += v;
                bonusLiquido += v - (v * pct / 100);
                bonusRecebido += b.recebido || 0;
            });
            const bonusFalta = Math.max(0, bonusLiquido - bonusRecebido);
            // Beneficiário: um só nome, ou "Vários" se misturado
            const _benefs = [...new Set(bonusList.map(b => b.beneficiario).filter(Boolean))];
            const bonusBenefLabel = _benefs.length === 0 ? '' : (_benefs.length === 1 ? _benefs[0] : 'Vários');
            // % nota: mostra se todos iguais, senão vazio
            const _pcts = [...new Set(bonusList.map(b => b.pctNota || 0))];
            const bonusPctNota = (_pcts.length === 1 ? _pcts[0] : '');
            // Data/mês do último recebimento de bônus com data
            let bonusDataReceb = '', bonusMesReceb = '';
            const _comData = bonusList.filter(b => b.data).sort((a,b) => (a.data < b.data ? -1 : 1));
            if(_comData.length) {
                const pb = String(_comData[_comData.length-1].data).split('-'); // YYYY-MM-DD
                if(pb.length === 3) {
                    bonusDataReceb = pb[2] + '/' + pb[1] + '/' + pb[0];
                    bonusMesReceb = MESES_PT[parseInt(pb[1],10)-1] + '/' + pb[0];
                }
            }
            try {
                const broker = DB.users.find(u => u.name === lead.broker);
                const agora = new Date();
                await fetch(SHEETS_URL, {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({
                        action: 'sync',
                        id: leadSheetId(lead),
                        data: lead.date || lead.dataAnalise || agora.toLocaleDateString('pt-BR'),
                        mes: mesRefDeDataBR(lead.date) || lead.mesAnalise || labelMesComercial(agora),
                        corretor: lead.broker || '',
                        equipe: broker?.team || '',
                        cliente: lead.name || '',
                        construtora: lead.construtora || '',
                        empreendimento: lead.project || '',
                        dataAprovacao: lead.dataAprovacao || '',
                        mesAprovacao: lead.mesAprovacao || '',
                        analise: resultadoAnalise(lead),
                        dataGanho: ganho.data,
                        mesGanho: ganho.mes,
                        ganho: ehFin ? 'Sim' : (lead.pipeline === 'cancelados' ? 'Não' : ''),
                        cancelado: lead.pipeline === 'cancelados',
                        situacao: situacaoAtual(lead),
                        vgv: ehFin ? (lead.vgv || 0) : '',
                        comissaoTotal: com ? com.bruta : '',
                        percentualNota: com ? com.pctNota : '',
                        valorDescontoNota: com ? com.descontoNota : '',
                        comissaoLiquida: com ? com.liquida : '',
                        comissaoCorretor: com ? com.corretor : '',
                        comissaoGerente: com ? com.gerente : '',
                        recebidoCorretor: ehFin ? recCorr : '',
                        recebidoGerente: ehFin ? recGer : '',
                        totalRecebido: ehFin ? totalRecebido : '',
                        faltaReceber: ehFin ? faltaReceber : '',
                        mesRecebimento: mesRec,
                        detalheRecebimentos: detalheRec,
                        temBonus: ehFin ? (lead.temBonus || 'Não') : '',
                        bonusBeneficiario: temBonus ? bonusBenefLabel : '',
                        valorBonus: temBonus ? bonusTotal : '',
                        bonusPctNota: temBonus ? bonusPctNota : '',
                        bonusLiquido: temBonus ? bonusLiquido : '',
                        bonusRecebido: temBonus ? bonusRecebido : '',
                        bonusFalta: temBonus ? bonusFalta : '',
                        bonusDataRecebido: bonusDataReceb,
                        bonusMesRecebido: bonusMesReceb
                    })
                });
                if(tracked && !lead.naPlanilha) { lead.naPlanilha = true; persistLeads(); }
            } catch(e) { console.error('Erro ao sincronizar planilha:', e); }
        }

        // Copia o código do robô para a área de transferência
        window.copiarCodigoRobo = function() {
            const ta = document.getElementById('sheets-robo-code');
            if(!ta) return;
            ta.select();
            navigator.clipboard.writeText(ta.value)
                .then(() => showToast('Código copiado! Cole no Apps Script.', 'success'))
                .catch(() => { document.execCommand('copy'); showToast('Código copiado!', 'success'); });
        }

        // Salva o percentual da Nota (Diretor)
        window.salvarPercentualNota = async function() {
            const v = parseFloat(document.getElementById('config-nota').value) || 0;
            if(v < 0 || v > 100) { showToast('O percentual deve estar entre 0 e 100.', 'error'); return; }
            CONFIG.percentualNota = v;
            await saveConfigDB();
            triggerAutoSaveUI();
            showToast(`Percentual da Nota salvo: ${v}%`, 'success');
        }

        // ====================================================================
        // MÊS COMERCIAL (Diretor) — períodos que substituem o mês do calendário
        // ====================================================================
        function _fmtDataBRcurta(iso) {
            const dt = _parseDataQualquer(iso);
            if(!dt) return '—';
            return String(dt.getDate()).padStart(2,'0') + '/' + String(dt.getMonth()+1).padStart(2,'0') + '/' + dt.getFullYear();
        }

        window.renderMesesComerciais = function() {
            // Popula o select de meses (uma vez)
            const sel = document.getElementById('mescom-mes');
            if(sel && !sel.options.length) {
                sel.innerHTML = MESES_PT.map((m,i) => `<option value="${i}">${m}</option>`).join('');
            }
            const anoInput = document.getElementById('mescom-ano');
            if(anoInput && !anoInput.value) anoInput.value = new Date().getFullYear();

            const lista = document.getElementById('mescom-lista');
            if(!lista) return;
            const periodos = CONFIG.mesesComerciais || [];
            if(periodos.length === 0) {
                lista.innerHTML = `<div class="text-center text-slate-500 py-6 text-sm"><i class="fa-regular fa-calendar text-2xl block mb-2 opacity-50"></i>Nenhum mês comercial cadastrado ainda.</div>`;
                return;
            }
            // Ordena por data de início
            const ordenados = [...periodos].map((p,i) => ({...p, _idx: i})).sort((a,b) => (_parseDataQualquer(a.inicio)||0) - (_parseDataQualquer(b.inicio)||0));
            lista.innerHTML = ordenados.map(p => `
                <div class="flex items-center justify-between gap-3 bg-slate-900/40 border border-slate-700/50 rounded-xl px-4 py-3">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-9 h-9 rounded-lg bg-cyan-500/15 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-calendar-week text-cyan-400 text-sm"></i></div>
                        <div class="min-w-0">
                            <p class="text-sm font-bold text-white truncate">${p.ref}</p>
                            <p class="text-[11px] text-slate-400">${_fmtDataBRcurta(p.inicio)} → ${_fmtDataBRcurta(p.fim)}</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-1 flex-shrink-0">
                        <button onclick="editarMesComercial(${p._idx})" title="Editar" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"><i class="fa-solid fa-pen text-xs"></i></button>
                        <button onclick="excluirMesComercial(${p._idx})" title="Excluir" class="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>
                </div>`).join('');
        }

        window.salvarMesComercial = async function() {
            if(currentUser.role !== 'Diretor') { showToast('Apenas o Diretor pode configurar o mês comercial.', 'error'); return; }
            const mesIdx = parseInt(document.getElementById('mescom-mes').value, 10);
            const ano = parseInt(document.getElementById('mescom-ano').value, 10);
            const inicio = document.getElementById('mescom-inicio').value;
            const fim = document.getElementById('mescom-fim').value;
            if(isNaN(mesIdx) || isNaN(ano)) { showToast('Selecione o mês e o ano de referência.', 'error'); return; }
            if(!inicio || !fim) { showToast('Preencha as datas de início e encerramento.', 'error'); return; }
            if(_parseDataQualquer(fim) < _parseDataQualquer(inicio)) { showToast('O encerramento não pode ser antes do início.', 'error'); return; }
            const ref = MESES_PT[mesIdx] + '/' + ano;
            const novo = { ref, inicio, fim };
            CONFIG.mesesComerciais = CONFIG.mesesComerciais || [];
            const editing = document.getElementById('mescom-editing').value;
            if(editing !== '') {
                CONFIG.mesesComerciais[parseInt(editing,10)] = novo;
            } else {
                // Evita duplicar o mesmo mês de referência
                const existe = CONFIG.mesesComerciais.findIndex(p => p.ref === ref);
                if(existe >= 0) CONFIG.mesesComerciais[existe] = novo;
                else CONFIG.mesesComerciais.push(novo);
            }
            await saveConfigDB();
            cancelarEdicaoMesComercial();
            renderMesesComerciais();
            showToast(`Mês comercial salvo: ${ref}`, 'success');
        }

        window.editarMesComercial = function(idx) {
            const p = (CONFIG.mesesComerciais || [])[idx];
            if(!p) return;
            const partes = String(p.ref).split('/');
            const mesIdx = MESES_PT.indexOf(partes[0]);
            document.getElementById('mescom-mes').value = mesIdx >= 0 ? mesIdx : 0;
            document.getElementById('mescom-ano').value = partes[1] || new Date().getFullYear();
            document.getElementById('mescom-inicio').value = p.inicio || '';
            document.getElementById('mescom-fim').value = p.fim || '';
            document.getElementById('mescom-editing').value = String(idx);
            document.getElementById('mescom-btn-label').textContent = 'Salvar Alterações';
            document.getElementById('mescom-cancel').classList.remove('hidden');
        }

        window.excluirMesComercial = async function(idx) {
            if(currentUser.role !== 'Diretor') { showToast('Apenas o Diretor pode excluir.', 'error'); return; }
            const p = (CONFIG.mesesComerciais || [])[idx];
            if(!p) return;
            if(!confirm(`Excluir o mês comercial "${p.ref}"?`)) return;
            CONFIG.mesesComerciais.splice(idx, 1);
            await saveConfigDB();
            cancelarEdicaoMesComercial();
            renderMesesComerciais();
            showToast('Mês comercial excluído.', 'info');
        }

        window.cancelarEdicaoMesComercial = function() {
            const ed = document.getElementById('mescom-editing'); if(ed) ed.value = '';
            const lbl = document.getElementById('mescom-btn-label'); if(lbl) lbl.textContent = 'Novo Mês Comercial';
            const cancel = document.getElementById('mescom-cancel'); if(cancel) cancel.classList.add('hidden');
            const ini = document.getElementById('mescom-inicio'); if(ini) ini.value = '';
            const fim = document.getElementById('mescom-fim'); if(fim) fim.value = '';
        }

        // Salva o link do robô configurado pelo Diretor
        window.salvarSheetsURL = async function() {
            const url = (document.getElementById('sheets-url-input').value || '').trim();
            if(!url) { showToast('Cole o link do robô.', 'error'); return; }
            if(!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) {
                if(!confirm('Esse link não parece um Web App do Google (termina em /exec). Salvar mesmo assim?')) return;
            }
            await saveSheetsURL(url);
            triggerAutoSaveUI();
            showToast('Link da planilha salvo!', 'success');
        }

        // Testa a conexão enviando uma linha de teste para a planilha
        window.testarSheets = async function() {
            const url = (document.getElementById('sheets-url-input').value || '').trim();
            if(!url) { showToast('Cole o link do robô primeiro.', 'error'); return; }
            try {
                await fetch(url, {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({
                        action: 'sync', id: '#TESTE-CONEXAO',
                        data: getDateStr(), mes: MESES_PT[new Date().getMonth()] + '/' + new Date().getFullYear(),
                        corretor: 'Teste', equipe: 'Teste', cliente: 'TESTE DE CONEXÃO',
                        construtora: '', empreendimento: '', analise: 'Em Análise',
                        situacao: 'Em Análise', ganho: '', vgv: '', comissaoTotal: '', comissaoCorretor: '', comissaoImob: ''
                    })
                });
                showToast('Teste enviado! Confira se apareceu uma linha "TESTE DE CONEXÃO" na planilha (pode apagar depois).', 'success');
            } catch(e) {
                showToast('Não foi possível enviar o teste. Verifique o link.', 'error');
            }
        }

        // Exclui TODOS os leads (mantém usuários). Dupla confirmação.
        window.limparTodosLeads = async function() {
            if(currentUser.role !== 'Diretor') { showToast('Apenas o Diretor pode fazer isso.', 'error'); return; }
            const total = DB.leads.length;
            if(total === 0) { showToast('Não há leads para excluir.', 'info'); return; }
            if(!confirm(`⚠️ ATENÇÃO: isso vai EXCLUIR PERMANENTEMENTE os ${total} leads do sistema.\n\nOs usuários são mantidos. Esta ação NÃO pode ser desfeita.\n\nDeseja continuar?`)) return;
            const txt = prompt('Para confirmar, digite EXCLUIR (em maiúsculas):');
            if(txt !== 'EXCLUIR') { showToast('Cancelado. Nada foi excluído.', 'info'); return; }
            try {
                showToast('Excluindo leads...', 'info');
                const { error } = await _sb.from('leads').delete().neq('id', '___never___');
                if(error) throw error;
                // Remove o blob antigo e marca como inicializado, para os leads NÃO voltarem ao atualizar
                await dbDelete(DB_KEYS.LEADS);
                await dbSet(DB_KEYS.SEEDED, JSON.stringify(true));
                DB.leads = [];
                _leadsSnapshot = {};
                updateNavCounters();
                if(['leads','analise','financeiro','cancelados','distribuir'].includes(currentView)) navigate('dashboard');
                renderDashboard();
                showToast(`${total} leads excluídos com sucesso.`, 'success');
                addNotification(`${total} leads foram excluídos por ${currentUser.name}`, 'warning');
            } catch(e) {
                showToast('Erro ao excluir: ' + e.message, 'error');
            }
        }

        // Reenvia todos os leads relevantes para a planilha (no formato atual)
        window.ressincronizarPlanilha = async function() {
            const leads = DB.leads.filter(l => ['analise','financeiro','cancelados'].includes(l.pipeline));
            if(!leads.length) { showToast('Nenhum lead em Análise/Ganho/Cancelado para sincronizar.', 'info'); return; }
            if(!confirm(`Reenviar ${leads.length} lead(s) para a planilha no formato atual?\n\nDica: limpe as linhas antigas da planilha antes (deixando só o cabeçalho).`)) return;
            showToast(`Sincronizando ${leads.length} leads... aguarde.`, 'info');
            let n = 0;
            for(const l of leads) {
                l.naPlanilha = true; // garante que cancelados também sejam enviados
                await sincronizarPlanilha(l);
                n++;
                await new Promise(r => setTimeout(r, 200)); // evita sobrecarregar o robô
            }
            await saveLeadsDB();
            showToast(`Planilha ressincronizada! ${n} leads enviados.`, 'success');
        }

        // Quando entra em Análise: registra a data/mês de referência (uma vez) e sincroniza
        async function enviarParaPlanilhaAnalise(lead) {
            const agora = new Date();
            if(!lead.dataAnalise) lead.dataAnalise = agora.toLocaleDateString('pt-BR');
            if(!lead.mesAnalise) lead.mesAnalise = labelMesComercial(agora);
            await sincronizarPlanilha(lead);
        }

        // Alias mantido para compatibilidade — agora sincroniza qualquer pipeline relevante
        async function sincronizarStatusAnalise(lead) {
            await sincronizarPlanilha(lead);
        }
        function getTime() { const n = new Date(); return n.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) + ' ' + n.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
        function getDateStr() { return new Date().toLocaleDateString('pt-BR'); }
        function formatCurrency(v) { return 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2}); }

        window.resetSystem = async function() {
            if(confirm('Tem certeza? Todos os dados serão apagados permanentemente.')) {
                await _sb.from('crm_storage').delete().neq('key', '___never___');
                await _sb.from('leads').delete().neq('id', '___never___');
                await _sb.from('users').delete().neq('id', '___never___');
                localStorage.clear(); location.reload();
            }
        }

        // ====================================================================
        // 2. INICIALIZAÇÃO DO BANCO (Supabase)
        // ====================================================================
        async function initDB(allowSeed = true) {
            // Carrega usuários da nova tabela "users" (1 linha por usuário)
            let loadedUsers = await loadUsersFromDB();

            // Migração automática: se a tabela nova está vazia mas existe o blob antigo
            if(loadedUsers !== null && loadedUsers.length === 0) {
                const oldBlob = await dbGet(DB_KEYS.USERS);
                if(oldBlob) {
                    const oldUsers = JSON.parse(oldBlob);
                    await _sb.from('users').upsert(oldUsers.map(u => ({ id: u.id, data: u })), { onConflict: 'id' });
                    loadedUsers = oldUsers;
                    console.log('Migração: ' + oldUsers.length + ' usuários movidos para a nova tabela.');
                }
            }

            if(loadedUsers && loadedUsers.length > 0) {
                DB.users = loadedUsers;
            } else if(allowSeed) {
                DB.users = [
                    { id: 'u1', email: 'diretor@audaz.com', pass: '123456', name: 'Admin Audaz', role: 'Diretor', status: 'Ativo', phone: '', team: 'Diretoria', goal: 0, commission: 0, photo: null, lastAccess: null, createdAt: getDateStr() },
                    { id: 'u2', email: 'adm@audaz.com', pass: '123456', name: 'Operacional', role: 'Administrativo', status: 'Ativo', phone: '', team: 'Administrativo', goal: 0, commission: 0, photo: null, lastAccess: null, createdAt: getDateStr() },
                    { id: 'u3', email: 'gerente@audaz.com', pass: '123456', name: 'Amanda', role: 'Gerente', status: 'Ativo', phone: '', team: 'Equipe Centro', goal: 200000, commission: 1.5, photo: null, lastAccess: null, createdAt: getDateStr() },
                    { id: 'u4', email: 'corretor@audaz.com', pass: '123456', name: 'Carlos', role: 'Corretor', status: 'Ativo', phone: '', team: 'Equipe Centro', goal: 50000, commission: 3, photo: null, lastAccess: null, createdAt: getDateStr() }
                ];
                await _sb.from('users').upsert(DB.users.map(u => ({ id: u.id, data: u })), { onConflict: 'id' });
            } else {
                // Sem sessão oficial: não semeia nada (evita criar usuários de demonstração/backdoor)
                DB.users = loadedUsers || [];
            }

            // Snapshot inicial dos usuários (referência para salvar só o que mudar)
            _usersSnapshot = _rebuildSnapshot(DB.users);

            DB.users.forEach(u => {
                if(u.phone === undefined) u.phone = '';
                if(u.team === undefined) u.team = '';
                if(u.goal === undefined) u.goal = 0;
                if(u.commission === undefined) u.commission = 0;
                if(u.photo === undefined) u.photo = null;
                if(u.lastAccess === undefined) u.lastAccess = null;
                if(u.createdAt === undefined) u.createdAt = getDateStr();
            });

            // Verifica se o sistema já foi inicializado alguma vez (evita re-semear/re-migrar leads apagados)
            let jaInicializado = false;
            try { const s = await dbGet(DB_KEYS.SEEDED); jaInicializado = !!(s && JSON.parse(s)); } catch(e) {}

            // Carrega leads da nova tabela "leads" (1 linha por lead)
            let loadedLeads = await loadLeadsFromDB();

            // Migração do blob antigo: SÓ na primeira vez (se nunca foi inicializado)
            if(loadedLeads !== null && loadedLeads.length === 0 && !jaInicializado) {
                const oldBlob = await dbGet(DB_KEYS.LEADS);
                if(oldBlob) {
                    const oldLeads = JSON.parse(oldBlob);
                    await _sb.from('leads').upsert(oldLeads.map(l => ({ id: l.id, data: l, updated_at: new Date().toISOString() })), { onConflict: 'id' });
                    loadedLeads = oldLeads;
                    console.log('Migração: ' + oldLeads.length + ' leads movidos para a nova tabela.');
                }
            }

            if(loadedLeads && loadedLeads.length > 0) {
                DB.leads = loadedLeads;
            } else if(allowSeed && !jaInicializado) {
                // Primeira vez: cria os leads de demonstração
                const t = getTime(); const d = getDateStr();
                DB.leads = [
                    { id: generateId(), name: 'Rodrigo Alves', phone: '(11) 98765-4321', broker: 'Carlos', origin: 'Instagram', income: 6500, pipeline: 'leads', stageId: 'hot', order: 0, temp: 'Hot', tags: [], docs: ['rg','cpf'], files: [], timeline: [`[${t}] Lead criado no sistema`], date: d, opObs: '', email: 'rodrigo@email.com' },
                    { id: generateId(), name: 'Maria Souza', phone: '(11) 97777-8888', broker: 'Thaís', origin: 'Google', income: 8500, pipeline: 'leads', stageId: 'visita', order: 0, temp: 'Morno', tags: [], docs: ['rg','cpf','comp_residencia'], files: [], timeline: [`[${t}] Lead criado no sistema`], date: d, opObs: '', email: 'maria@email.com' },
                    { id: generateId(), name: 'João Pereira', phone: '(11) 96666-5555', broker: 'Amanda', origin: 'Indicação', income: 12000, pipeline: 'analise', stageId: 'em-analise', order: 0, temp: 'Hot', tags: [], docs: ['rg','cpf','comp_residencia','holerite','extrato'], files: [], timeline: [`[${t}] Lead criado no sistema`], date: d, opObs: '' },
                    { id: generateId(), name: 'Ana Costa', phone: '(11) 95555-4444', broker: 'Carlos', origin: 'Facebook', income: 5500, pipeline: 'analise', stageId: 'aprovado', order: 0, temp: 'Hot', tags: [], docs: ['rg','cpf','comp_residencia','holerite','extrato','fgts','irpf'], files: [], timeline: [`[${t}] Lead criado no sistema`], date: d, opObs: '' },
                    { id: generateId(), name: 'Pedro Santos', phone: '(11) 94444-3333', broker: 'Thaís', origin: 'Site', income: 15000, pipeline: 'financeiro', stageId: 'venda-gerada', order: 0, temp: 'Hot', tags: [], docs: DOC_CHECKLIST_ITEMS.map(d=>d.id), files: [], timeline: [`[${t}] Lead criado no sistema`], date: d, opObs: '', propertyValue: 450000, vgv: 520000 }
                ];
                await _sb.from('leads').upsert(DB.leads.map(l => ({ id: l.id, data: l, updated_at: new Date().toISOString() })), { onConflict: 'id' });
            } else {
                // Já inicializado e sem leads = ficou vazio de propósito
                DB.leads = [];
            }

            // Marca como inicializado (não re-semeia/re-migra nas próximas vezes)
            if(allowSeed && !jaInicializado) { try { await dbSet(DB_KEYS.SEEDED, JSON.stringify(true)); } catch(e) {} }

            // Snapshot inicial dos leads
            _leadsSnapshot = _rebuildSnapshot(DB.leads);

            const STAGE_MIGRATION = { 'distribuido': 'aguardando', 'nao-compareceu': 'visita', 'enviado-analise': 'doc-recebida' };
            let leadsMigrated = false;
            DB.leads.forEach(l => {
                if(l.pipeline === 'leads' && STAGE_MIGRATION[l.stageId]) { l.stageId = STAGE_MIGRATION[l.stageId]; leadsMigrated = true; }
                if(l.vgv === undefined) l.vgv = 0;
                if(l.commissionValue === undefined) l.commissionValue = 0;
                if(l.saleDate === undefined) l.saleDate = null;
                if(l.updatedAt === undefined) l.updatedAt = null;
                if(l.updatedBy === undefined) l.updatedBy = null;
                if(l.createdAt === undefined) l.createdAt = l.date ? l.date + ' ' + (l.timeCreated || '00:00') : new Date().toISOString();
                // Corrige datas no formato brasileiro DD/MM/YYYY HH:MM → ISO
                if(l.createdAt && isNaN(new Date(l.createdAt))) {
                    const m = l.createdAt.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
                    if(m) { l.createdAt = new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).toISOString(); leadsMigrated = true; }
                }
                if(l.updatedAt && isNaN(new Date(l.updatedAt))) {
                    const m = l.updatedAt.match(/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?/);
                    if(m) { l.updatedAt = new Date(+m[3], +m[2]-1, +m[1], +(m[4]||0), +(m[5]||0)).toISOString(); leadsMigrated = true; }
                }
            });
            if(leadsMigrated) await persistLeads();

            // Migração: atribui número de ID sequencial aos leads que ainda não têm
            let maxNumId = 0;
            DB.leads.forEach(l => { if(typeof l.numId === 'number' && l.numId > maxNumId) maxNumId = l.numId; });
            let numIdMigrated = false;
            // Ordena por data de criação para numerar na ordem certa
            const semNumId = DB.leads.filter(l => typeof l.numId !== 'number')
                .sort((a,b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
            semNumId.forEach(l => { maxNumId++; l.numId = maxNumId; numIdMigrated = true; });
            if(numIdMigrated) await persistLeads();

            // Migração: normaliza nomes de corretores nos leads para bater com usuários cadastrados
            let brokerMigrated = false;
            DB.leads.forEach(l => {
                if(!l.broker) return;
                const exact = DB.users.find(u => u.name === l.broker);
                if(!exact) {
                    // Tenta match parcial (ex: "Thaís" → "Thaís Abreu")
                    const partial = DB.users.find(u =>
                        u.name.toLowerCase().startsWith(l.broker.toLowerCase()) ||
                        l.broker.toLowerCase().startsWith(u.name.toLowerCase())
                    );
                    if(partial) { l.broker = partial.name; brokerMigrated = true; }
                }
            });
            if(brokerMigrated) await persistLeads();

            // Migração: remove usuários duplicados (mesmo nome, mantém o primeiro)
            const seenNames = new Set();
            const beforeCount = DB.users.length;
            DB.users = DB.users.filter(u => {
                if(seenNames.has(u.name)) return false;
                seenNames.add(u.name);
                return true;
            });
            if(DB.users.length !== beforeCount) await persistUsers();

            // Carrega notificações
            try {
                const savedNotifs = await dbGet(DB_KEYS.NOTIFICATIONS);
                DB.notifications = savedNotifs ? JSON.parse(savedNotifs) : [];
            } catch(e) { DB.notifications = []; }

            // Carrega pipelines customizados
            try {
                const savedPipelines = await dbGet(DB_KEYS.PIPELINES);
                if(savedPipelines) {
                    const parsed = JSON.parse(savedPipelines);
                    // Mantém cancelados do default, merge os demais
                    PIPELINES.leads = parsed.leads || PIPELINES_DEFAULT.leads;
                    PIPELINES.analise = parsed.analise || PIPELINES_DEFAULT.analise;
                    PIPELINES.financeiro = parsed.financeiro || PIPELINES_DEFAULT.financeiro;
                }
            } catch(e) { /* usa default */ }

            // Carrega listas (construtoras / empreendimentos)
            try {
                const savedListas = await dbGet(DB_KEYS.LISTAS);
                if(savedListas) {
                    const parsed = JSON.parse(savedListas);
                    LISTAS.construtoras = Array.isArray(parsed.construtoras) ? parsed.construtoras : [];
                    LISTAS.empreendimentos = Array.isArray(parsed.empreendimentos) ? parsed.empreendimentos : [];
                }
            } catch(e) { /* usa vazio */ }

            // Carrega o link do robô do Google (se o Diretor configurou)
            try {
                const savedSheets = await dbGet(DB_KEYS.SHEETS);
                if(savedSheets) { const u = JSON.parse(savedSheets); if(u) SHEETS_URL = u; }
            } catch(e) { /* usa o padrão */ }

            // Carrega configurações gerais (% da Nota)
            try {
                const savedConfig = await dbGet(DB_KEYS.CONFIG);
                if(savedConfig) { const c = JSON.parse(savedConfig); if(c && typeof c.percentualNota === 'number') CONFIG.percentualNota = c.percentualNota; if(c && Array.isArray(c.mesesComerciais)) CONFIG.mesesComerciais = c.mesesComerciais; }
            } catch(e) { /* usa padrão */ }
        }

        async function saveSheetsURL(url) {
            SHEETS_URL = url;
            await dbSet(DB_KEYS.SHEETS, JSON.stringify(url));
        }

        async function saveConfigDB() {
            await dbSet(DB_KEYS.CONFIG, JSON.stringify(CONFIG));
        }

        async function savePipelinesDB() {
            await dbSet(DB_KEYS.PIPELINES, JSON.stringify({
                leads: PIPELINES.leads,
                analise: PIPELINES.analise,
                financeiro: PIPELINES.financeiro
            }));
        }

        async function saveListasDB() {
            await dbSet(DB_KEYS.LISTAS, JSON.stringify(LISTAS));
        }

        async function saveUsersDB() {
            try {
                await persistUsers();
                triggerAutoSaveUI();
            } catch(err) {
                showToast('Erro ao salvar usuários.', 'error');
            }
        }

        async function saveLeadsDB() {
            try {
                await persistLeads();
                updateNavCounters();
                if(currentView === 'dashboard') renderDashboard();
                triggerAutoSaveUI();
            } catch(err) {
                showToast('Erro ao salvar dados.', 'error');
            }
        }

        async function saveNotifications() {
            await dbSet(DB_KEYS.NOTIFICATIONS, JSON.stringify(DB.notifications));
        }

        function triggerAutoSaveUI(indicatorId) {
            const ind = indicatorId ? document.getElementById(indicatorId) : null;
            const globalInd = document.getElementById('auto-save-indicator');
            if(ind) {
                ind.classList.add('saving'); ind.classList.remove('saved'); ind.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Salvando...';
                setTimeout(() => { ind.classList.remove('saving'); ind.classList.add('saved'); ind.innerHTML = '<i class="fa-solid fa-check"></i> Salvo'; }, 600);
            }
            if(globalInd) {
                clearTimeout(autoSaveTimeout);
                globalInd.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Salvando...';
                globalInd.className = 'text-xs font-bold text-amber-300 bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/30';
                autoSaveTimeout = setTimeout(() => {
                    globalInd.innerHTML = '<i class="fa-solid fa-cloud-arrow-up mr-1"></i> Auto Salvo';
                    globalInd.className = 'text-xs font-bold text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-full border border-emerald-500/20';
                }, 600);
            }
        }

        // ====================================================================
        // 3. SISTEMA DE TOAST
        // ====================================================================
        function showToast(message, type = 'success') {
            const container = document.getElementById('toast-container');
            const colors = {
                success: 'bg-emerald-600 border-emerald-500',
                error: 'bg-red-600 border-red-500',
                info: 'bg-blue-600 border-blue-500',
                warning: 'bg-orange-600 border-orange-500'
            };
            const icons = {
                success: 'fa-check-circle',
                error: 'fa-exclamation-circle',
                info: 'fa-info-circle',
                warning: 'fa-triangle-exclamation'
            };
            const toast = document.createElement('div');
            toast.className = `${colors[type]} text-white px-5 py-4 rounded-xl shadow-2xl flex items-center gap-3 toast-enter pointer-events-auto border-l-4 min-w-[300px] max-w-md`;
            toast.innerHTML = `<i class="fa-solid ${icons[type]} text-xl"></i><span class="text-sm font-medium flex-1">${message}</span><button onclick="this.parentElement.classList.add('toast-exit'); setTimeout(()=>this.parentElement.remove(), 300)" class="text-white/70 hover:text-white"><i class="fa-solid fa-times"></i></button>`;
            container.appendChild(toast);
            setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); }, 4000);
        }

        // ====================================================================
        // 4. NOTIFICAÇÕES
        // ====================================================================
        function addNotification(message, type = 'info') {
            DB.notifications.unshift({
                id: generateId(), message, type,
                date: new Date().toISOString(),
                read: false
            });
            if(DB.notifications.length > 50) DB.notifications = DB.notifications.slice(0, 50);
            saveNotifications();
            renderNotifications();
        }

        function renderNotifications() {
            const list = document.getElementById('notif-list');
            const badge = document.getElementById('notif-badge');
            const unread = DB.notifications.filter(n => !n.read).length;
            
            if(unread > 0) { badge.classList.remove('hidden'); badge.textContent = unread > 99 ? '99+' : unread; }
            else badge.classList.add('hidden');

            if(DB.notifications.length === 0) {
                list.innerHTML = '<div class="p-8 text-center text-slate-500"><i class="fa-regular fa-bell-slash text-3xl mb-2 block"></i><p class="text-sm">Nenhuma notificação</p></div>';
                return;
            }

            const icons = { success: 'fa-check-circle text-emerald-400', error: 'fa-exclamation-circle text-red-400', info: 'fa-info-circle text-blue-400', warning: 'fa-triangle-exclamation text-orange-400' };
            
            list.innerHTML = DB.notifications.map(n => {
                const date = new Date(n.date);
                const time = date.toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit'});
                const day = date.toLocaleDateString('pt-BR');
                return `<div class="p-4 border-b border-slate-700/50 hover:bg-slate-700/30 ${!n.read ? 'bg-blue-500/5' : ''}">
                    <div class="flex gap-3">
                        <i class="fa-solid ${icons[n.type] || icons.info} mt-1"></i>
                        <div class="flex-1">
                            <p class="text-sm text-white">${n.message}</p>
                            <p class="text-[10px] text-slate-500 mt-1 uppercase tracking-wider">${day} • ${time}</p>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        window.toggleNotifications = function() {
            const panel = document.getElementById('notif-panel');
            panel.classList.toggle('hidden');
            if(!panel.classList.contains('hidden')) {
                DB.notifications.forEach(n => n.read = true);
                saveNotifications();
                setTimeout(renderNotifications, 200);
            }
        }

        window.clearNotifications = function() {
            DB.notifications = []; saveNotifications(); renderNotifications();
        }

        // Click outside notifications
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('notif-panel');
            if(!panel || panel.classList.contains('hidden')) return;
            if(!e.target.closest('#notif-panel') && !e.target.closest('[onclick*="toggleNotifications"]')) {
                panel.classList.add('hidden');
            }
        });

        // ====================================================================
        // 5. AUTENTICAÇÃO E SESSÃO
        // ====================================================================
        // Detecta se a URL atual é um link de redefinição de senha (formato antigo com #hash
        // OU o formato novo/PKCE com ?code= na query). Como o app não usa login social,
        // um ?code= é praticamente sempre o link de recuperação.
        function _ehLinkRecovery() {
            const h = window.location.hash || '';
            const s = window.location.search || '';
            if(h.indexOf('type=recovery') !== -1) return true;
            if(s.indexOf('type=recovery') !== -1) return true;
            if(s.indexOf('code=') !== -1) return true;
            return false;
        }

        async function checkAuth() {
            // Link de redefinição de senha (vindo do e-mail): NÃO desloga — deixa o modal de nova senha abrir
            if(_ehLinkRecovery()) {
                showLogin();
                // Garante que o modal de nova senha apareça mesmo que o evento PASSWORD_RECOVERY
                // já tenha disparado antes desta função rodar
                setTimeout(() => { if(typeof openModal === 'function') openModal('modal-nova-senha'); }, 300);
                return;
            }
            // Só retoma a sessão se houver login OFICIAL (Supabase Auth) ativo
            let session = null;
            try { const r = await _sb.auth.getSession(); session = r?.data?.session || null; } catch(_) {}
            const sessionActive = localStorage.getItem(DB_KEYS.SESSION);
            const loggedUserStr = localStorage.getItem(DB_KEYS.LOGGED_USER);

            if (session && sessionActive === 'active' && loggedUserStr) {
                await initDB(true); // autenticado: carrega os dados de verdade
                try {
                    const storedUser = JSON.parse(loggedUserStr);
                    const validUser = DB.users.find(u => u.email === storedUser.email);
                    if(validUser) {
                        currentUser = validUser;
                        localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(currentUser));
                        const lastPage = localStorage.getItem(DB_KEYS.LAST_PAGE) || 'dashboard';
                        showApp(lastPage);
                    } else { forcarLoginLimpo(); }
                } catch(e) { forcarLoginLimpo(); }
            } else {
                // Sem sessão oficial → vai pro login (não carrega dados sem autenticar)
                forcarLoginLimpo();
            }
        }

        // Limpa a sessão local e leva pra tela de login (sem o "deseja sair?")
        function forcarLoginLimpo() {
            _logoutIntencional = true;
            try { _sb.auth.signOut(); } catch(_) {}
            localStorage.removeItem(DB_KEYS.SESSION);
            localStorage.removeItem(DB_KEYS.LOGGED_USER);
            currentUser = null;
            showLogin();
        }

        // Cria/atualiza a senha OFICIAL (Supabase Auth) de um usuário, via robô do Google
        function sincronizarSenhaOficial(email, senha) {
            if(!email || !senha || !SHEETS_URL) return;
            try {
                fetch(SHEETS_URL, {
                    method: 'POST', mode: 'no-cors',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'definirSenhaUsuario', email: email, senha: senha })
                });
            } catch(_) {}
        }

        // ====================================================================
        // RECUPERAÇÃO DE SENHA (envia senha temporária por email via robô Google)
        // ====================================================================
        window.abrirRecuperarSenha = function(e) {
            if(e) e.preventDefault();
            openModal('modal-recuperar-senha');
        }

        window.enviarRecuperarSenha = async function() {
            const email = document.getElementById('rec-email').value.trim().toLowerCase();
            if(!email) { showToast('Digite seu e-mail.', 'error'); return; }
            const btn = document.getElementById('rec-btn');
            const loader = document.getElementById('rec-loader');
            btn.disabled = true; loader.classList.remove('hidden');
            try {
                // Sistema oficial do Supabase envia o link de redefinição (pelo seu Gmail via SMTP)
                const redirect = window.location.origin + window.location.pathname;
                const { error } = await _sb.auth.resetPasswordForEmail(email, { redirectTo: redirect });
                if(error) throw error;
                closeModal('modal-recuperar-senha');
                showToast('Se o e-mail estiver cadastrado, enviamos um link para redefinir a senha. Verifique a caixa de entrada e o spam.', 'success');
            } catch(err) {
                showToast('Não foi possível enviar agora. Tente novamente em alguns minutos.', 'error');
            } finally {
                btn.disabled = false; loader.classList.add('hidden');
            }
        }

        // Salva a nova senha (após o usuário clicar no link do e-mail)
        window.salvarNovaSenha = async function() {
            const nova = document.getElementById('nova-senha-input').value;
            const conf = document.getElementById('nova-senha-confirma').value;
            if(!nova || nova.length < 6) { showToast('A senha precisa de pelo menos 6 caracteres.', 'error'); return; }
            if(nova !== conf) { showToast('As senhas não conferem.', 'error'); return; }
            const btn = document.getElementById('nova-senha-btn');
            const loader = document.getElementById('nova-senha-loader');
            btn.disabled = true; loader.classList.remove('hidden');
            try {
                const { error } = await _sb.auth.updateUser({ password: nova });
                if(error) throw error;
                // Senha gerenciada exclusivamente pelo Supabase Auth — não grava em texto plano
                _logoutIntencional = true;
                await _sb.auth.signOut();
                closeModal('modal-nova-senha');
                showToast('Senha redefinida com sucesso! Entre com a nova senha.', 'success');
                // Limpa o hash do link e mostra o login
                try { history.replaceState(null, '', window.location.pathname); } catch(_) {}
                showLogin();
            } catch(err) {
                showToast('Erro ao salvar a senha: ' + (err.message || ''), 'error');
            } finally {
                btn.disabled = false; loader.classList.add('hidden');
            }
        }

        window.handleLogin = async function(e) {
            e.preventDefault();
            const email = document.getElementById('login-email').value.trim().toLowerCase();
            const pass = document.getElementById('login-password').value.trim();
            const btn = document.getElementById('btn-login');
            const loader = document.getElementById('login-loader');

            const falhar = (msg) => {
                btn.querySelector('span').innerText = 'Entrar no Sistema';
                loader.classList.add('hidden');
                btn.disabled = false;
                showToast(msg || 'E-mail ou senha incorretos.', 'error');
                document.getElementById('form-login').classList.add('shake');
                setTimeout(() => document.getElementById('form-login').classList.remove('shake'), 300);
            };

            btn.querySelector('span').innerText = 'Autenticando...';
            loader.classList.remove('hidden');
            btn.disabled = true;

            // 1) LOGIN OFICIAL (Supabase Auth) — ÚNICO método aceito. Sem fallback.
            let authOk = false;
            try {
                const { data, error } = await _sb.auth.signInWithPassword({ email, password: pass });
                authOk = !error && !!data?.user;
            } catch(_) { authOk = false; }

            // Se o Auth oficial falhou, nega o acesso imediatamente
            if(!authOk) { return falhar('E-mail ou senha incorretos.'); }

            // 2) Carrega os dados (RLS garante que só funciona com sessão Supabase válida)
            try { await initDB(true); } catch(_) {}

            // 3) Localiza o perfil do usuário na tabela users
            let user = DB.users.find(u => (u.email||'').toLowerCase() === email);

            if (!user) { return falhar(); }
            if(user.status === 'Inativo') { return falhar('Usuário inativo. Entre em contato com o administrador.'); }

            btn.querySelector('span').innerText = 'Entrar no Sistema';
            loader.classList.add('hidden');
            btn.disabled = false;

            // Atualiza último acesso
            user.lastAccess = new Date().toISOString();
            saveUsersDB();

            currentUser = user;
            localStorage.setItem(DB_KEYS.SESSION, 'active');
            localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(user));
            localStorage.setItem(DB_KEYS.LAST_PAGE, 'dashboard');
            showToast(`Bem-vindo, ${user.name}!`, 'success');
            addNotification(`Login realizado: ${user.name}`, 'success');
            showApp('dashboard');
        }

        window.handleLogout = function() {
            if(currentUser && !confirm('Deseja realmente sair do sistema?')) return;
            _logoutIntencional = true;
            try { _sb.auth.signOut(); } catch(_) {} // encerra a sessão oficial (Supabase Auth)
            localStorage.removeItem(DB_KEYS.SESSION);
            localStorage.removeItem(DB_KEYS.LOGGED_USER);
            localStorage.removeItem(DB_KEYS.LAST_PAGE);
            currentUser = null;
            showToast('Sessão encerrada.', 'info');
            showLogin();
        }

        window.togglePassword = function() {
            const input = document.getElementById('login-password'); const icon = document.getElementById('icon-eye');
            if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye','fa-eye-slash'); } 
            else { input.type = 'password'; icon.classList.replace('fa-eye-slash','fa-eye'); }
        }

        window.fillLogin = function(email) {
            document.getElementById('login-email').value = email;
        }

        function showLogin() {
            document.getElementById('app-crm').classList.add('hidden');
            document.getElementById('app-crm').classList.remove('opacity-100');
            const login = document.getElementById('app-login');
            login.classList.remove('hidden');
            setTimeout(() => login.classList.remove('opacity-0'), 10);
            loadSysLogo();
        }

        function showApp(startPage = 'dashboard') {
            const login = document.getElementById('app-login'); 
            login.classList.add('opacity-0');
            setTimeout(() => {
                login.classList.add('hidden');
                const app = document.getElementById('app-crm'); 
                app.classList.remove('hidden'); 
                setTimeout(() => app.classList.add('opacity-100'), 10);
                startCRM(startPage);
            }, 300);
        }

        // ====================================================================
        // 6. SETUP DA APLICAÇÃO
        // ====================================================================
        function startCRM(startPage) {
            setupUIForUser();
            setupNavigation();
            setupForms();
            setupAutoSaveListeners();
            setupMasks();
            setupKeyboardShortcuts();
            setupGlobalSearch();
            populateBrokerDropdowns();
            updateNavCounters();
            renderNotifications();
            loadProfileForm();
            loadSysLogo();
            setupRealtime();
            navigate(startPage);
        }

        function setupUIForUser() {
            updateUserAvatars();
            document.getElementById('header-user-name').innerText = currentUser.name;
            document.getElementById('header-user-role').innerText = currentUser.role;
            document.getElementById('drop-name').innerText = currentUser.name;
            document.getElementById('drop-email').innerText = currentUser.email;
            // dash-greeting/dash-subtitle não existem mais (dashboard virou BI) — protege contra null
            const _greet = document.getElementById('dash-greeting');
            if(_greet) _greet.innerText = `Olá, ${currentUser.name.split(' ')[0]}!`;
            const subtitleMap = {
                'Diretor': 'Visão estratégica completa do seu negócio',
                'Gerente': 'Acompanhe a performance da sua equipe',
                'Administrativo': 'Gerencie operações e documentação',
                'Corretor': 'Seus leads e oportunidades'
            };
            const _sub = document.getElementById('dash-subtitle');
            if(_sub) _sub.innerText = subtitleMap[currentUser.role] || 'Bem-vindo';

            const navManagement = document.getElementById('nav-management');
            if (currentUser.role === 'Corretor') navManagement.classList.add('hidden'); 
            else navManagement.classList.remove('hidden');

            // Mostrar botão Usuários & Acessos para quem pode gerenciar
            const navUsersBtn = document.getElementById('nav-users-btn');
            if(canManageUsers()) navUsersBtn.classList.remove('hidden');
            else navUsersBtn.classList.add('hidden');

            // Mostrar backup e logo só para diretor
            const backupPanel = document.getElementById('prof-backup-panel');
            const logoPanel = document.getElementById('prof-logo-panel');
            const pipelinesPanel = document.getElementById('prof-pipelines-panel');
            const listasPanel = document.getElementById('prof-listas-panel');
            if(currentUser.role === 'Diretor') {
                backupPanel.classList.remove('hidden');
                logoPanel.classList.remove('hidden');
                if(pipelinesPanel) { pipelinesPanel.classList.remove('hidden'); renderPipelineEditor('leads'); }
                if(listasPanel) { listasPanel.classList.remove('hidden'); renderListasEditor(); }
                const sheetsPanel = document.getElementById('prof-sheets-panel');
                if(sheetsPanel) { sheetsPanel.classList.remove('hidden'); const si = document.getElementById('sheets-url-input'); if(si) si.value = SHEETS_URL; }
                const comissaoPanel = document.getElementById('prof-comissao-panel');
                if(comissaoPanel) { comissaoPanel.classList.remove('hidden'); const ci = document.getElementById('config-nota'); if(ci) ci.value = CONFIG.percentualNota || ''; }
                const mescomPanel = document.getElementById('prof-mescom-panel');
                if(mescomPanel) { mescomPanel.classList.remove('hidden'); renderMesesComerciais(); }
                loadSysLogo();
            } else {
                backupPanel.classList.add('hidden');
                logoPanel.classList.add('hidden');
                if(pipelinesPanel) pipelinesPanel.classList.add('hidden');
                if(listasPanel) listasPanel.classList.add('hidden');
                const sheetsPanelH = document.getElementById('prof-sheets-panel');
                if(sheetsPanelH) sheetsPanelH.classList.add('hidden');
                const comissaoPanelH = document.getElementById('prof-comissao-panel');
                if(comissaoPanelH) comissaoPanelH.classList.add('hidden');
                const mescomPanelH = document.getElementById('prof-mescom-panel');
                if(mescomPanelH) mescomPanelH.classList.add('hidden');
            }

            // Mostrar "Leads a Distribuir" para Diretor, Gerente e Administrativo
            const navDistribuirBtn = document.getElementById('nav-distribuir-btn');
            if(navDistribuirBtn) {
                if(['Diretor','Gerente','Administrativo'].includes(currentUser.role)) {
                    navDistribuirBtn.classList.remove('hidden');
                } else {
                    navDistribuirBtn.classList.add('hidden');
                }
            }
        }

        function updateUserAvatars() {
            const initials = currentUser.name.substring(0, 2).toUpperCase();
            document.getElementById('header-user-initials').innerText = initials;
            document.getElementById('prof-initials').innerText = initials;
            
            const headerImg = document.getElementById('header-user-img');
            const profImg = document.getElementById('prof-img-preview');
            
            if (currentUser.photo) { 
                document.getElementById('header-user-initials').classList.add('hidden'); 
                headerImg.src = currentUser.photo; headerImg.classList.remove('hidden'); 
                document.getElementById('prof-initials').classList.add('hidden');
                profImg.src = currentUser.photo; profImg.classList.remove('hidden');
            } else { 
                document.getElementById('header-user-initials').classList.remove('hidden'); 
                headerImg.classList.add('hidden'); 
                document.getElementById('prof-initials').classList.remove('hidden');
                profImg.classList.add('hidden');
            }
        }

        function setupNavigation() {
            window.navigate = function(view) {
                currentView = view;
                localStorage.setItem(DB_KEYS.LAST_PAGE, view);
                if(window.fecharGavetaMobile) window.fecharGavetaMobile();
                document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
                document.querySelectorAll('.nav-btn').forEach(btn => { 
                    btn.classList.remove('bg-primary/20', 'text-blue-400'); 
                    btn.classList.add('text-slate-400');
                });
                
                const activeBtn = document.querySelector(`.nav-btn[data-target="${view}"]`);
                if(activeBtn) { activeBtn.classList.remove('text-slate-400'); activeBtn.classList.add('bg-primary/20', 'text-blue-400'); }

                if (view === 'dashboard') { 
                    document.getElementById('view-dashboard').classList.remove('hidden'); 
                    renderDashboard(); 
                } else if (['leads', 'analise', 'financeiro'].includes(view)) {
                    currentPipeline = view; 
                    document.getElementById('view-kanban').classList.remove('hidden');
                    const titles = { leads: 'Pipeline de Vendas', analise: 'Esteira de Crédito', financeiro: 'Ganhos / Financeiro' };
                    document.getElementById('kanban-title').innerText = titles[view];
                    renderKanban(view, true); // true = anima a entrada das colunas ao abrir o pipeline
                } else if(view === 'profile') {
                    document.getElementById('view-profile').classList.remove('hidden');
                    loadProfileForm();
                    renderProfileStats();
                } else if(view === 'distribuir') {
                    document.getElementById('view-distribuir').classList.remove('hidden');
                    renderDistribuir();
                } else if(view === 'cancelados') {
                    document.getElementById('view-cancelados').classList.remove('hidden');
                    renderCancelados();
                } else if(view === 'users') {
                    if(!canManageUsers()) { showToast('Você não tem permissão para acessar esta área.', 'error'); navigate('dashboard'); return; }
                    document.getElementById('view-users').classList.remove('hidden');
                    renderUsersTable();
                } else if(view === 'agenda') {
                    document.getElementById('view-agenda').classList.remove('hidden');
                } else if(view === 'faturamento') {
                    document.getElementById('view-faturamento').classList.remove('hidden');
                    renderFaturamento();
                } else if(['equipe','relatorios'].includes(view)) {
                    document.getElementById('view-placeholder').classList.remove('hidden');
                    const map = {
                        equipe: { icon: 'fa-user-tie', title: 'Equipe', desc: 'Em breve: gestão completa de corretores, gerentes e permissões.' },
                        relatorios: { icon: 'fa-chart-line', title: 'Relatórios', desc: 'Em breve: relatórios detalhados de performance, conversão e financeiro.' }
                    };
                    const data = map[view];
                    document.getElementById('placeholder-icon').className = `fa-solid ${data.icon} text-6xl text-primary`;
                    document.getElementById('placeholder-title').innerText = data.title;
                    document.getElementById('placeholder-desc').innerText = data.desc;
                }
            };
        }

        function updateNavCounters() {
            const visibleLeads = getVisibleLeads();
            let visibleCanceled = DB.leads.filter(l => l.pipeline === 'cancelados');
            if(currentUser.role === 'Corretor') visibleCanceled = visibleCanceled.filter(l => l.broker === currentUser.name);
            else if(currentUser.role === 'Gerente' && currentUser.team) {
                const teamBrokers = DB.users.filter(u => u.team === currentUser.team).map(u => u.name);
                visibleCanceled = visibleCanceled.filter(l => teamBrokers.includes(l.broker));
            }
            document.getElementById('counter-leads').textContent = visibleLeads.filter(l => l.pipeline === 'leads').length;
            document.getElementById('counter-analise').textContent = visibleLeads.filter(l => l.pipeline === 'analise').length;
            document.getElementById('counter-financeiro').textContent = visibleLeads.filter(l => l.pipeline === 'financeiro').length;
            const counterCancelados = document.getElementById('counter-cancelados');
            if(counterCancelados) counterCancelados.textContent = visibleCanceled.length;
            // Badge de usuários
            const counterUsers = document.getElementById('counter-users');
            if(counterUsers && canManageUsers()) counterUsers.textContent = DB.users.length;
            // Badge leads a distribuir
            const counterDistribuir = document.getElementById('counter-distribuir');
            if(counterDistribuir) counterDistribuir.textContent = DB.leads.filter(l => l.pipeline === 'distribuicao').length;
        }

        // ====================================================================
        // SIDEBAR TOGGLE
        // ====================================================================
window.toggleSidebar = function() {
            const sidebar = document.getElementById('main-sidebar');
            const icon = document.getElementById('sidebar-toggle-icon');
            const backdrop = document.getElementById('sidebar-backdrop');
            if(window.innerWidth <= 768) {
                // Celular: gaveta deslizante por cima
                const open = sidebar.classList.toggle('mobile-open');
                if(backdrop) backdrop.classList.toggle('show', open);
                return;
            }
            // Computador: encolher/expandir (comportamento original)
            sidebar.classList.toggle('sidebar-collapsed');
            const collapsed = sidebar.classList.contains('sidebar-collapsed');
            icon.className = collapsed ? 'fa-solid fa-bars-staggered text-base' : 'fa-solid fa-bars text-base';
        }
        // Fecha a gaveta no celular (ex.: ao navegar)
        window.fecharGavetaMobile = function() {
            if(window.innerWidth <= 768) {
                const sidebar = document.getElementById('main-sidebar');
                const backdrop = document.getElementById('sidebar-backdrop');
                if(sidebar) sidebar.classList.remove('mobile-open');
                if(backdrop) backdrop.classList.remove('show');
            }
        }

        // ====================================================================
        // LEADS A DISTRIBUIR
        // ====================================================================
        function renderDistribuir() {
            const leads = DB.leads.filter(l => l.pipeline === 'distribuicao');
            const list = document.getElementById('distribuir-list');
            const empty = document.getElementById('distribuir-empty');
            if(leads.length === 0) {
                list.innerHTML = '';
                list.classList.add('hidden');
                empty.classList.remove('hidden');
                return;
            }
            list.classList.remove('hidden');
            empty.classList.add('hidden');
            list.innerHTML = leads.map(lead => {
                const brokers = DB.users.filter(u => u.role === 'Corretor').map(u => `<option value="${u.name}">${u.name}</option>`).join('');
                return `
                <div class="glass border border-amber-500/20 rounded-xl p-5 flex flex-col gap-3 hover:border-amber-400/40 transition-colors">
                    <div class="flex items-start justify-between">
                        <div>
                            <h3 class="font-bold text-white text-base">${lead.name}</h3>
                            <p class="text-xs text-slate-400 mt-0.5"><i class="fa-solid fa-phone mr-1"></i>${lead.phone || '—'}</p>
                            <p class="text-xs text-slate-400"><i class="fa-solid fa-tag mr-1"></i>${lead.origin || '—'}</p>
                        </div>
                        <span class="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-bold">Aguardando</span>
                    </div>
                    <div class="border-t border-slate-700/50 pt-3">
                        <label class="text-xs text-slate-400 font-bold uppercase tracking-wider mb-1 block">Distribuir para:</label>
                        <div class="flex gap-2">
                            <select id="dist-broker-${lead.id}" class="flex-1 bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400">
                                <option value="">Selecione o corretor</option>
                                ${brokers}
                            </select>
                            <button onclick="distribuirLead('${lead.id}')" class="bg-amber-500 hover:bg-amber-400 text-white px-4 py-2 rounded-lg font-bold text-sm transition-colors flex items-center gap-1">
                                <i class="fa-solid fa-paper-plane"></i>
                            </button>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        window.distribuirLead = function(leadId) {
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead) return;
            const brokerName = document.getElementById(`dist-broker-${leadId}`).value;
            if(!brokerName) { showToast('Selecione um corretor.', 'error'); return; }
            lead.broker = brokerName;
            lead.pipeline = 'leads';
            lead.stageId = 'aguardando';
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;
            lead.timeline.unshift(`[${getTime()}] ${currentUser.name} distribuiu lead para ${brokerName}`);
            saveLeadsDB();
            renderDistribuir();
            updateNavCounters();
            showToast(`Lead distribuído para ${brokerName}!`, 'success');
            addNotification(`Lead "${lead.name}" distribuído para ${brokerName}`, 'success');
        }

        window.openNewLeadModalDistribuir = function() {
            openNewLeadModal();
            // Força pipeline distribuicao após abrir o modal
            setTimeout(() => {
                const select = document.getElementById('nl-broker');
                if(select) { select.value = 'Não Atribuído'; select.disabled = false; }
                window._pendingDistribuir = true;
            }, 100);
        }

        // Preenche os dropdowns de Construtora e Empreendimento a partir das listas do Diretor
        function populateListaDropdowns(lead) {
            const fill = (inputId, datalistId, items, currentValue) => {
                const input = document.getElementById(inputId);
                const dl = document.getElementById(datalistId);
                if(!dl) return;
                dl.innerHTML = items.map(it => `<option value="${_escAttr(it)}"></option>`).join('');
                if(input) input.value = currentValue || '';
            };
            fill('ld-construtora', 'dl-construtoras', LISTAS.construtoras, lead?.construtora);
            fill('ld-project', 'dl-empreendimentos', LISTAS.empreendimentos, lead?.project);
        }

        function populateBrokerDropdowns() {
            const brokers = DB.users.filter(u => u.role === 'Corretor' || u.role === 'Gerente').map(u => u.name);
            const allOptions = ['<option value="Não Atribuído">Não Atribuído</option>'].concat(brokers.map(b => `<option value="${b}">${b}</option>`)).join('');
            
            const newLeadSelect = document.getElementById('nl-broker');
            if(newLeadSelect) newLeadSelect.innerHTML = allOptions;
            
            const ldBrokerSelect = document.getElementById('ld-broker');
            if(ldBrokerSelect) ldBrokerSelect.innerHTML = allOptions;
            
            const kanbanFilter = document.getElementById('kanban-filter-broker');
            if(kanbanFilter) {
                const prev = kanbanFilter.value;
                kanbanFilter.innerHTML = '<option value="">Todos os Corretores</option>' + brokers.map(b => `<option value="${b}">${b}</option>`).join('');
                kanbanFilter.value = prev;
            }

            // Popular filtro de equipes (apenas equipes únicas, excluindo vazias e Diretoria/Administrativo)
            const teamFilter = document.getElementById('kanban-filter-team');
            if(teamFilter) {
                const allTeams = [...new Set(DB.users
                    .filter(u => u.role === 'Corretor' || u.role === 'Gerente')
                    .map(u => u.team)
                    .filter(t => t && t.trim().length > 0)
                )].sort();
                const prev = teamFilter.value;
                teamFilter.innerHTML = '<option value="">Todas Equipes</option>' + allTeams.map(t => `<option value="${t}">${t}</option>`).join('');
                teamFilter.value = prev;
                // Esconder filtro de equipe pra Corretor (só vê os dele) e pra Gerente (já filtrado)
                if(currentUser && (currentUser.role === 'Corretor' || currentUser.role === 'Gerente')) {
                    teamFilter.classList.add('hidden');
                } else {
                    teamFilter.classList.remove('hidden');
                }
            }
        }

        // ====================================================================
        // 7. ATALHOS DE TECLADO
        // ====================================================================
        function setupKeyboardShortcuts() {
            document.addEventListener('keydown', (e) => {
                if(!currentUser) return;
                
                // Ctrl+N - Novo Lead
                if(e.ctrlKey && e.key === 'n') {
                    e.preventDefault();
                    openNewLeadModal();
                }
                // Ctrl+K - Foco na busca
                if(e.ctrlKey && e.key === 'k') {
                    e.preventDefault();
                    document.getElementById('global-search').focus();
                }
                // Esc - Fechar modais
                if(e.key === 'Escape') {
                    ['modal-password','modal-new-lead','modal-lead-details','modal-user','modal-move-client','modal-cancel-lead'].forEach(id => {
                        const m = document.getElementById(id);
                        if(m && !m.classList.contains('hidden')) closeModal(id);
                    });
                    document.getElementById('notif-panel')?.classList.add('hidden');
                    document.getElementById('search-results')?.classList.add('hidden');
                }
            });
        }

        // ====================================================================
        // 8. MÁSCARAS DE INPUT
        // ====================================================================
        function setupMasks() {
            document.querySelectorAll('.phone-mask').forEach(input => {
                if(input.dataset.maskApplied) return;
                input.dataset.maskApplied = '1';
                input.addEventListener('input', (e) => {
                    let v = e.target.value.replace(/\D/g, '');
                    if(v.length > 11) v = v.slice(0,11);
                    if(v.length > 10) v = v.replace(/^(\d{2})(\d{5})(\d{4}).*/, '($1) $2-$3');
                    else if(v.length > 6) v = v.replace(/^(\d{2})(\d{4})(\d{0,4}).*/, '($1) $2-$3');
                    else if(v.length > 2) v = v.replace(/^(\d{2})(\d{0,5}).*/, '($1) $2');
                    else if(v.length > 0) v = v.replace(/^(\d{0,2}).*/, '($1');
                    e.target.value = v;
                });
            });
            
            document.querySelectorAll('.cpf-mask').forEach(input => {
                if(input.dataset.maskApplied) return;
                input.dataset.maskApplied = '1';
                input.addEventListener('input', (e) => {
                    let v = e.target.value.replace(/\D/g, '');
                    if(v.length > 11) v = v.slice(0,11);
                    if(v.length > 9) v = v.replace(/^(\d{3})(\d{3})(\d{3})(\d{0,2}).*/, '$1.$2.$3-$4');
                    else if(v.length > 6) v = v.replace(/^(\d{3})(\d{3})(\d{0,3}).*/, '$1.$2.$3');
                    else if(v.length > 3) v = v.replace(/^(\d{3})(\d{0,3}).*/, '$1.$2');
                    e.target.value = v;
                });
            });

            // Máscara monetária R$ — formata enquanto digita (padrão pt-BR)
            document.querySelectorAll('.currency-mask').forEach(input => {
                if(input.dataset.maskApplied) return;
                input.dataset.maskApplied = '1';
                input.setAttribute('inputmode', 'numeric');
                input.addEventListener('input', (e) => {
                    let v = e.target.value.replace(/\D/g, '');
                    if(!v) { e.target.value = ''; return; }
                    // Trabalha em centavos: 12345 → 123,45 ; 1 → 0,01 ; 250000 → 2.500,00
                    v = (parseInt(v, 10) / 100).toFixed(2);
                    v = v.replace('.', ',');
                    v = v.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1.');
                    e.target.value = 'R$ ' + v;
                });
                input.addEventListener('focus', (e) => {
                    if(!e.target.value || e.target.value === 'R$ 0,00') e.target.value = '';
                });
                input.addEventListener('blur', (e) => {
                    if(!e.target.value.replace(/\D/g,'')) e.target.value = '';
                });
            });
        }

        // Converte "R$ 250.000,00" → 250000 (número)
        window.parseCurrency = function(str) {
            if(typeof str === 'number') return str;
            if(!str) return 0;
            const onlyDigits = String(str).replace(/\D/g, '');
            if(!onlyDigits) return 0;
            return parseInt(onlyDigits, 10) / 100;
        }

        // Converte 250000 → "R$ 250.000,00"
        window.formatCurrencyInput = function(num) {
            const n = Number(num) || 0;
            if(n === 0) return '';
            return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // ====================================================================
        // 9. BUSCA GLOBAL
        // ====================================================================
        function setupGlobalSearch() {
            const input = document.getElementById('global-search');
            const results = document.getElementById('search-results');
            
            input.addEventListener('input', debounce((e) => {
                const q = e.target.value.trim().toLowerCase();
                if(q.length < 2) { results.classList.add('hidden'); return; }
                
                // Inclui também cancelados visíveis ao usuário
                const allVisible = [
                    ...getVisibleLeads(),
                    ...DB.leads.filter(l => {
                        if(l.pipeline !== 'cancelados') return false;
                        if(currentUser.role === 'Corretor') return l.broker === currentUser.name;
                        if(currentUser.role === 'Gerente' && currentUser.team) {
                            const teamBrokers = DB.users.filter(u => u.team === currentUser.team).map(u => u.name);
                            return teamBrokers.includes(l.broker);
                        }
                        return true;
                    })
                ];
                // Dedup
                const seen = new Set();
                const allUnique = allVisible.filter(l => { if(seen.has(l.id)) return false; seen.add(l.id); return true; });

                const qNum = q.replace(/[#\s]/g, ''); // permite buscar "#0012", "0012" ou "12"
                const found = allUnique.filter(l =>
                    l.name.toLowerCase().includes(q) ||
                    (l.phone || '').toLowerCase().includes(q) ||
                    (l.cpf || '').toLowerCase().includes(q) ||
                    (l.email || '').toLowerCase().includes(q) ||
                    (l.project || '').toLowerCase().includes(q) ||
                    (l.broker || '').toLowerCase().includes(q) ||
                    (l.numId && (String(l.numId) === qNum || formatNumId(l.numId).toLowerCase().includes(q) || String(l.numId).padStart(4,'0').includes(qNum)))
                ).slice(0, 10);
                
                if(found.length === 0) {
                    results.innerHTML = '<div class="p-6 text-center text-slate-500"><i class="fa-solid fa-magnifying-glass mb-2 block text-2xl"></i><p class="text-sm">Nenhum resultado encontrado para "<b>'+q+'</b>"</p></div>';
                } else {
                    results.innerHTML = found.map(l => {
                        const pipelineMap = {leads:'Leads', analise:'Análise', financeiro:'Ganhos', cancelados:'CANCELADO'};
                        const pipelineName = pipelineMap[l.pipeline] || l.pipeline;
                        const stageName = PIPELINES[l.pipeline]?.find(s => s.id === l.stageId)?.title || (l.pipeline === 'cancelados' ? (l.cancelReason || 'Cancelado') : '');
                        const isCanceled = l.pipeline === 'cancelados';
                        const cancelBadge = isCanceled ? '<span class="text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/40 px-1.5 py-0.5 rounded ml-2">CANCELADO</span>' : '';
                        return `<button onclick="openLeadDetails('${l.id}'); document.getElementById('search-results').classList.add('hidden'); document.getElementById('global-search').value='';" class="w-full text-left p-4 hover:bg-slate-700/40 border-b border-slate-700/50 transition-colors flex items-center gap-4 ${isCanceled ? 'opacity-70' : ''}">
                            <div class="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center text-sm font-bold text-white ${isCanceled ? 'grayscale' : ''}">${l.name.charAt(0).toUpperCase()}</div>
                            <div class="flex-1 overflow-hidden">
                                <p class="text-sm font-bold text-white truncate">${l.numId ? '<span class="text-blue-400 mr-1">'+formatNumId(l.numId)+'</span>' : ''}${l.name}${cancelBadge}</p>
                                <p class="text-xs text-slate-400 truncate">${l.phone || ''} • ${pipelineName} ${stageName ? '/ ' + stageName : ''} ${l.broker ? '• ' + l.broker : ''}</p>
                            </div>
                            <i class="fa-solid fa-arrow-right text-slate-500"></i>
                        </button>`;
                    }).join('');
                }
                results.classList.remove('hidden');
            }, 200));

            input.addEventListener('keydown', (e) => {
                if(e.key === 'Escape') {
                    input.value = '';
                    results.classList.add('hidden');
                    input.blur();
                }
            });

            document.addEventListener('click', (e) => {
                if(!e.target.closest('#global-search') && !e.target.closest('#search-results')) {
                    results.classList.add('hidden');
                    input.value = '';
                }
            });
        }

        // ====================================================================
        // 10. DASHBOARD
        // ====================================================================
        function renderDashboard() {
            // Dashboard agora é o BI Audaz embarcado (iframe) — sem KPIs/gráficos internos
            if(document.getElementById('bi-iframe')) return;
            const visibleLeads = getVisibleLeads();
            // Leads cancelados visíveis (para indicador, não entram no funil)
            let visibleCanceled = DB.leads.filter(l => l.pipeline === 'cancelados');
            if(currentUser.role === 'Corretor') visibleCanceled = visibleCanceled.filter(l => l.broker === currentUser.name);
            else if(currentUser.role === 'Gerente' && currentUser.team) {
                const teamBrokers = DB.users.filter(u => u.team === currentUser.team).map(u => u.name);
                visibleCanceled = visibleCanceled.filter(l => teamBrokers.includes(l.broker));
            }
            const period = document.getElementById('dash-period')?.value || 'all';
            
            let filtered = visibleLeads;
            const now = new Date();
            if(period === 'today') filtered = visibleLeads.filter(l => l.date === getDateStr());
            else if(period === 'week') {
                const weekAgo = new Date(); weekAgo.setDate(now.getDate() - 7);
                filtered = visibleLeads.filter(l => {
                    const [d,m,y] = (l.date || '').split('/').map(Number);
                    return new Date(y,m-1,d) >= weekAgo;
                });
            } else if(period === 'month') {
                filtered = visibleLeads.filter(l => {
                    const [d,m,y] = (l.date || '').split('/').map(Number);
                    return m === now.getMonth()+1 && y === now.getFullYear();
                });
            }
            
            // KPIs
            const activeLeads = filtered.filter(l => l.pipeline === 'leads').length;
            const totalAnalises = filtered.filter(l => l.pipeline === 'analise' || l.pipeline === 'financeiro').length;
            const totalAprovados = filtered.filter(l => (l.pipeline === 'analise' && l.stageId === 'aprovado') || l.pipeline === 'financeiro').length;
            const totalVendas = filtered.filter(l => l.pipeline === 'financeiro').length;
            const approvals = totalAprovados;
            const vgv = filtered.filter(l => l.pipeline === 'financeiro').reduce((sum, l) => sum + (Number(l.vgv) || Number(l.propertyValue) || 0), 0);
            const totalCommission = filtered.filter(l => l.pipeline === 'financeiro').reduce((sum, l) => sum + (Number(l.commissionValue) || 0), 0);
            // Se não houver comissões individuais lançadas, estima pela taxa do usuário
            const commissionRate = Number(currentUser.commission) || 5;
            const commission = totalCommission > 0 ? totalCommission : vgv * (commissionRate / 100);
            const newToday = visibleLeads.filter(l => l.date === getDateStr()).length;
            const totalLeads = filtered.length;
            const approvalRate = totalLeads > 0 ? Math.round((approvals / totalLeads) * 100) : 0;

            document.getElementById('dash-leads-today').textContent = activeLeads;
            document.getElementById('dash-leads-new').textContent = '+' + newToday;
            document.getElementById('dash-approvals').textContent = approvals;
            document.getElementById('dash-approval-rate').textContent = approvalRate + '%';
            document.getElementById('dash-vgv').textContent = formatCurrency(vgv);
            document.getElementById('dash-comission').textContent = formatCurrency(commission);

            // Indicadores e Conversões
            const setText = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
            setText('ind-analises', totalAnalises);
            setText('ind-aprovados', totalAprovados);
            setText('ind-vendas', totalVendas);
            setText('ind-analises-rate', (totalLeads > 0 ? Math.round((totalAnalises / totalLeads) * 100) : 0) + '% dos leads');
            setText('ind-aprovados-rate', (totalAnalises > 0 ? Math.round((totalAprovados / totalAnalises) * 100) : 0) + '% análises');
            setText('ind-vendas-rate', (totalLeads > 0 ? Math.round((totalVendas / totalLeads) * 100) : 0) + '% conversão');
            setText('ind-conv-leads', (totalLeads > 0 ? Math.round((totalAnalises / totalLeads) * 100) : 0) + '%');
            setText('ind-conv-analise', (totalAnalises > 0 ? Math.round((totalAprovados / totalAnalises) * 100) : 0) + '%');
            setText('ind-conv-venda', (totalAprovados > 0 ? Math.round((totalVendas / totalAprovados) * 100) : 0) + '%');

            // Indicador de cancelados
            const totalCanceledAll = visibleCanceled.length;
            const totalGeral = totalLeads + totalCanceledAll;
            const cancelRate = totalGeral > 0 ? Math.round((totalCanceledAll / totalGeral) * 100) : 0;
            setText('ind-cancelados', totalCanceledAll);
            setText('ind-cancelados-rate', cancelRate + '% taxa');

            // Ranking de Corretores (apenas Diretor/Admin/Gerente veem)
            renderBrokerRanking(filtered);

            // Recent leads
            const recent = [...filtered].sort((a,b) => (b.date || '').localeCompare(a.date || '')).slice(0,5);
            const recentTable = document.getElementById('recent-leads-table');
            if(recent.length === 0) {
                recentTable.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-500">Nenhum lead cadastrado ainda</td></tr>';
            } else {
                recentTable.innerHTML = recent.map(l => {
                    const pipelineName = {leads:'Leads', analise:'Análise', financeiro:'Financeiro'}[l.pipeline];
                    const pipelineColor = {leads:'bg-blue-500/20 text-blue-400', analise:'bg-purple-500/20 text-purple-400', financeiro:'bg-emerald-500/20 text-emerald-400'}[l.pipeline];
                    const valor = l.pipeline === 'financeiro' ? (l.vgv || l.propertyValue || 0) : (l.income || 0);
                    return `<tr class="border-b border-slate-800 hover:bg-slate-800/30 transition-colors cursor-pointer" onclick="openLeadDetails('${l.id}')">
                        <td class="py-3 px-2"><div class="flex items-center gap-3"><div class="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center text-sm font-bold">${l.name.charAt(0).toUpperCase()}</div><span class="font-medium text-white">${l.name}</span></div></td>
                        <td class="py-3 px-2"><span class="text-[10px] font-bold px-2 py-1 rounded ${pipelineColor} uppercase tracking-wider">${pipelineName}</span></td>
                        <td class="py-3 px-2 text-slate-300 text-sm">${l.broker || 'Não atribuído'}</td>
                        <td class="py-3 px-2 text-emerald-400 font-bold text-sm">${formatCurrency(valor)}</td>
                        <td class="py-3 px-2 text-slate-500 text-xs">${l.date}</td>
                    </tr>`;
                }).join('');
            }

            // Charts
            renderFunnelChart(filtered);
            renderOriginChart(filtered);
        }

        function renderFunnelChart(leads) {
            const ctx = document.getElementById('funnelChart');
            if(!ctx) return;
            if(charts.funnel) charts.funnel.destroy();
            
            const data = PIPELINES.leads.map(s => leads.filter(l => l.pipeline === 'leads' && l.stageId === s.id).length);
            
            charts.funnel = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: PIPELINES.leads.map(s => s.title),
                    datasets: [{
                        label: 'Leads',
                        data: data,
                        backgroundColor: ['#94a3b8','#60a5fa','#facc15','#f97316','#a78bfa','#4ade80','#ef4444','#2dd4bf','#6366f1'],
                        borderRadius: 6
                    }]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 } },
                    scales: {
                        x: { ticks: { color: '#94a3b8', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                        y: { ticks: { color: '#cbd5e1', font: { size: 11 } }, grid: { display: false } }
                    }
                }
            });
        }

        function renderOriginChart(leads) {
            const ctx = document.getElementById('originChart');
            if(!ctx) return;
            if(charts.origin) charts.origin.destroy();
            
            const origins = {};
            leads.forEach(l => { origins[l.origin || 'Outros'] = (origins[l.origin || 'Outros'] || 0) + 1; });
            const labels = Object.keys(origins);
            const values = Object.values(origins);
            
            if(labels.length === 0) { ctx.parentElement.innerHTML = '<div class="h-72 flex items-center justify-center text-slate-500"><div class="text-center"><i class="fa-solid fa-chart-pie text-4xl mb-3 empty-icon block"></i><p>Sem dados</p></div></div>'; return; }
            
            charts.origin = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: values,
                        backgroundColor: ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ec4899','#06b6d4','#ef4444'],
                        borderColor: '#0f172a',
                        borderWidth: 3
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '60%',
                    plugins: { 
                        legend: { position: 'right', labels: { color: '#cbd5e1', font: { size: 12 }, padding: 15 } },
                        tooltip: { backgroundColor: '#1e293b', borderColor: '#334155', borderWidth: 1 }
                    }
                }
            });
        }

        // ====================================================================
        // 11. KANBAN COM FILTROS
        // ====================================================================
        function getVisibleLeads() {
            if (!currentUser) return [];
            // Corretor: só vê os próprios leads
            if (currentUser.role === 'Corretor') return DB.leads.filter(l => l.broker === currentUser.name);
            // Gerente: vê apenas leads de corretores da sua equipe + os próprios
            if (currentUser.role === 'Gerente') {
                const myTeam = currentUser.team;
                if(!myTeam) return DB.leads.filter(l => l.broker === currentUser.name);
                const teamBrokers = DB.users
                    .filter(u => (u.role === 'Corretor' || u.role === 'Gerente') && u.team === myTeam)
                    .map(u => u.name);
                return DB.leads.filter(l => teamBrokers.includes(l.broker));
            }
            // Diretor e Administrativo: veem tudo
            return DB.leads;
        }

        function applyKanbanFilters(leads) {
            const search = (document.getElementById('kanban-search')?.value || '').toLowerCase();
            const team = document.getElementById('kanban-filter-team')?.value || '';
            const broker = document.getElementById('kanban-filter-broker')?.value || '';
            const temp = '';

            let filtered = leads;
            if(search) filtered = filtered.filter(l => l.name.toLowerCase().includes(search) || (l.phone || '').toLowerCase().includes(search) || (l.cpf || '').toLowerCase().includes(search));
            if(team) {
                // Filtro por equipe: lead pertence à equipe se seu broker está nessa equipe
                const teamBrokerNames = DB.users
                    .filter(u => (u.role === 'Corretor' || u.role === 'Gerente') && u.team === team)
                    .map(u => u.name);
                filtered = filtered.filter(l => teamBrokerNames.includes(l.broker));
            }
            if(broker) filtered = filtered.filter(l => l.broker === broker);
            if(temp) filtered = filtered.filter(l => l.temp === temp);
            
            // Render filter chips
            const chipsContainer = document.getElementById('kanban-active-filters');
            const chips = [];
            if(search) chips.push(`<span class="filter-chip">Busca: ${search} <button onclick="document.getElementById('kanban-search').value=''; renderKanban(currentPipeline)"><i class="fa-solid fa-times"></i></button></span>`);
            if(team) chips.push(`<span class="filter-chip">Equipe: ${team} <button onclick="document.getElementById('kanban-filter-team').value=''; renderKanban(currentPipeline)"><i class="fa-solid fa-times"></i></button></span>`);
            if(broker) chips.push(`<span class="filter-chip">Corretor: ${broker} <button onclick="document.getElementById('kanban-filter-broker').value=''; renderKanban(currentPipeline)"><i class="fa-solid fa-times"></i></button></span>`);
            chipsContainer.innerHTML = chips.join('');
            
            return filtered;
        }

        window.clearKanbanFilters = function() {
            document.getElementById('kanban-search').value = '';
            const teamFilter = document.getElementById('kanban-filter-team');
            if(teamFilter) teamFilter.value = '';
            document.getElementById('kanban-filter-broker').value = '';
            renderKanban(currentPipeline);
        }

        window.renderKanban = function(pipelineId, animate) {
            const board = document.getElementById('kanban-board');
            board.innerHTML = '';

            // SEGURANÇA: leads cuja etapa não existe mais neste pipeline (após editar/reordenar/
            // remover etapas) iriam "sumir" das colunas. Reancora-os na 1ª etapa para não perder ninguém.
            const stagesDoPipe = PIPELINES[pipelineId] || [];
            const idsValidos = new Set(stagesDoPipe.map(s => s.id));
            const primeiraEtapa = stagesDoPipe[0];
            if(primeiraEtapa) {
                let reancorou = false;
                DB.leads.forEach(l => {
                    if(l.pipeline === pipelineId && !idsValidos.has(l.stageId)) { l.stageId = primeiraEtapa.id; reancorou = true; }
                });
                if(reancorou) saveLeadsDB();
            }

            const allLeads = getVisibleLeads();
            const filteredLeads = applyKanbanFilters(allLeads);

            PIPELINES[pipelineId].forEach((stage, _ci) => {
                let stageLeads = filteredLeads.filter(l => l.pipeline === pipelineId && l.stageId === stage.id);
                // Ordena por urgência do follow-up: vencidos/mais próximos no topo,
                // follow-up distante mais abaixo, e sem follow-up por último.
                stageLeads.sort((a, b) => {
                    const fa = a.followUp ? new Date(a.followUp).getTime() : Infinity;
                    const fb = b.followUp ? new Date(b.followUp).getTime() : Infinity;
                    if(fa !== fb) return fa - fb;
                    return (a.order || 0) - (b.order || 0);
                });

                const totalIncome = stageLeads.reduce((s,l) => s + (Number(l.income) || 0), 0);
                const totalVgv = stageLeads.reduce((s,l) => s + (Number(l.vgv) || Number(l.propertyValue) || 0), 0);
                const showVgvHeader = currentPipeline === 'financeiro' && totalVgv > 0;

                const _animCls = (animate ? 'kanban-col-in' : '');
                const _animStyle = (animate ? `style="animation-delay:${_ci * 45}ms"` : '');
                const colHTML = `
                    <div class="min-w-[340px] w-[340px] kanban-col-mobile flex-shrink-0 flex flex-col h-full ${_animCls}" ${_animStyle}>
                        <div class="flex justify-between items-center mb-2.5 px-1">
                            <div class="flex items-center gap-2 min-w-0"><div class="w-2.5 h-2.5 rounded-full flex-shrink-0 ${stage.color.replace('border-l-','bg-')} shadow-[0_0_8px_currentColor]"></div><h3 class="font-bold text-slate-300 text-xs tracking-wider uppercase truncate">${stage.title}</h3></div>
                            <span class="bg-slate-800 text-slate-400 text-[11px] font-bold px-2 py-0.5 rounded-md border border-slate-700/60 flex-shrink-0">${stageLeads.length}</span>
                        </div>
                        ${showVgvHeader ? `<div class="text-[10px] text-emerald-400 font-bold uppercase tracking-wider mb-2 px-1">VGV total: ${formatCurrency(totalVgv)}</div>` : ''}
                        <div class="flex-1 bg-slate-800/30 rounded-xl border border-slate-700/50 p-3 overflow-y-auto custom-scrollbar sortable-col" data-stage="${stage.id}">
                            ${stageLeads.length === 0 ? '<div class="text-center text-slate-600 py-10 text-xs"><i class="fa-regular fa-folder-open text-2xl mb-2 block opacity-60"></i>Arraste um lead para cá</div>' : stageLeads.map(lead => generateCardHTML(lead)).join('')}
                        </div>
                    </div>`;
                board.insertAdjacentHTML('beforeend', colHTML);
            });

            if(window.Sortable) {
                document.querySelectorAll('.sortable-col').forEach(col => {
                    new Sortable(col, {
                        group: 'shared', animation: 150, ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
                        draggable: '.kanban-card', // só os cards arrastam (ignora o placeholder "Vazio")
                        delay: 50, delayOnTouchOnly: true,
                        onEnd: function (evt) {
                            const leadId = evt.item.dataset.id; 
                            const newStageId = evt.to.dataset.stage; 
                            const oldStageId = evt.from.dataset.stage;
                            // Drag-and-drop ENTRE ETAPAS do mesmo pipeline: PERMITIDO
                            // (movimentação entre pipelines diferentes só via botão "Mover Cliente")
                            if (newStageId !== oldStageId) { 
                                evt.item.classList.add('card-exit'); 
                                setTimeout(() => { moveLeadAndUpdateOrder(leadId, newStageId, evt.to); }, 250); 
                            } else { 
                                updateColumnOrder(evt.to); 
                            }
                        }
                    });
                });
            }
        }

        function followUpInfo(isoDatetime) {
            if(!isoDatetime) return null;
            const now = new Date(), fu = new Date(isoDatetime);
            const diff = fu - now;
            const abs = Math.abs(diff);
            const mins = Math.floor(abs / 60000);
            const hours = Math.floor(abs / 3600000);
            const days = Math.floor(abs / 86400000);
            let text;
            if(diff < 0) {
                if(mins < 60) text = `Venceu há ${mins}min`;
                else if(hours < 24) text = `Venceu há ${hours}h`;
                else text = `Venceu há ${days}d`;
            } else {
                if(mins < 60) text = `em ${mins}min`;
                else if(hours < 24) text = `em ${hours}h`;
                else text = `em ${days}d`;
            }
            return { text, overdue: diff < 0 };
        }

        function generateCardHTML(lead) {
            const initial = lead.name.charAt(0).toUpperCase();
            const colorClass = PIPELINES[lead.pipeline].find(s => s.id === lead.stageId)?.color || 'border-l-slate-500';
            const fu = followUpInfo(lead.followUp);
            const fuRow = fu
                ? `<div class="fu-badge-slot flex items-center gap-1.5 mt-2">
                    <span class="fu-badge inline-flex items-center gap-1 px-2 py-0.5 rounded ${fu.overdue ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-300'} text-[10px] font-semibold pointer-events-none"><i class="fa-solid fa-clock text-[9px]"></i>${fu.text}</span>
                    <button onclick="openFollowUpPicker(event,'${lead.id}')" title="Editar follow-up" class="w-5 h-5 rounded ${fu.overdue ? 'text-red-400 hover:bg-red-500' : 'text-blue-400 hover:bg-blue-500'} hover:text-white transition-all flex items-center justify-center text-[10px]"><i class="fa-solid fa-pen"></i></button>
                  </div>`
                : `<div class="fu-badge-slot mt-2">
                    <button onclick="openFollowUpPicker(event,'${lead.id}')" title="Agendar follow-up" class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-slate-500 hover:text-blue-300 text-[10px] font-medium transition-all"><i class="fa-solid fa-calendar-plus text-[9px]"></i>Follow-up</button>
                  </div>`;
            
            // Calcula progresso da documentação
            const docProgress = lead.docs ? Math.round((lead.docs.length / DOC_CHECKLIST_ITEMS.length) * 100) : 0;
            const progressColor = docProgress < 30 ? '#ef4444' : docProgress < 70 ? '#f59e0b' : '#10b981';

            return `
                <div class="kanban-card bg-slate-800/70 border border-slate-700/50 rounded-2xl p-3.5 mb-2.5 relative overflow-hidden ${colorClass} border-l-[3px] shadow-sm ${lead.hot ? 'card-hot' : ''}" data-id="${lead.id}" onclick="openLeadDetails('${lead.id}')">
                    <!-- Nome + Avatar -->
                    <div class="flex items-start gap-2.5 mb-2.5 pointer-events-none">
                        <div class="w-8 h-8 rounded-full bg-gradient-to-br ${lead.hot ? 'from-orange-500 to-red-500' : 'from-slate-600 to-slate-700'} flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">${initial}</div>
                        <div class="flex-1 min-w-0">
                            <h4 class="font-semibold text-[13px] text-white leading-snug">
                                ${lead.hot ? '<i class="fa-solid fa-fire text-orange-400 hot-flame text-[11px] mr-1"></i>' : ''}${lead.numId ? `<span class="text-blue-400/70 text-[10px] font-bold mr-1">${formatNumId(lead.numId)}</span>` : ''}${lead.name}
                            </h4>
                            <span class="text-[11px] text-slate-500">${lead.origin || '—'}</span>
                        </div>
                    </div>
                    <!-- Follow-up badge -->
                    ${fuRow}
                    <!-- Rodapé: corretor + VGV ou anexos -->
                    <div class="flex items-center justify-between mt-2.5 pt-2.5 border-t border-slate-700/30 pointer-events-none">
                        <span class="flex items-center gap-1.5 text-[11px] text-slate-400 min-w-0">
                            <i class="fa-solid fa-user text-[9px] text-slate-600 flex-shrink-0"></i>
                            <span class="truncate max-w-[110px]">${lead.broker || 'N/A'}</span>
                        </span>
                        ${lead.pipeline === 'financeiro' && (lead.vgv || lead.propertyValue)
                            ? `<span class="text-[11px] font-bold text-emerald-400 flex items-center gap-1"><i class="fa-solid fa-sack-dollar text-[9px]"></i>${formatCurrency(lead.vgv || lead.propertyValue || 0)}</span>`
                            : lead.files && lead.files.length > 0
                                ? `<span class="text-[11px] text-slate-500 flex items-center gap-1"><i class="fa-solid fa-paperclip text-[9px]"></i>${lead.files.length}</span>`
                                : ''
                        }
                    </div>
                </div>`;
        }

        function updateColumnOrder(columnEl) {
            Array.from(columnEl.children).forEach((card, index) => {
                if(!card.dataset.id) return;
                const lead = DB.leads.find(l => l.id === card.dataset.id); 
                if(lead) lead.order = index;
            });
            saveLeadsDB(); 
            triggerAutoSaveUI();
        }

        function moveLeadAndUpdateOrder(leadId, newStageId, newColumnEl) {
            const lead = DB.leads.find(l => l.id === leadId); 
            if (!lead) return;
            const t = getTime();
            
            // NÃO mover automaticamente entre pipelines.
            // Usuário precisa clicar manualmente em "Mover Cliente" no modal.
            // Movimentação dentro do MESMO pipeline (entre colunas):
            const stageName = PIPELINES[currentPipeline].find(s => s.id === newStageId).title;
            lead.stageId = newStageId;
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;
            lead.timeline.unshift(`[${t}] ${currentUser.name} moveu para: ${stageName}`);
            // Registra data/mês de aprovação na primeira vez que chega em Aprovado
            if(lead.pipeline === 'analise' && newStageId === 'aprovado' && !lead.dataAprovacao) {
                const na = new Date();
                lead.dataAprovacao = na.toLocaleDateString('pt-BR');
                lead.mesAprovacao = labelMesComercial(na);
            }
            updateColumnOrder(newColumnEl);
            saveLeadsDB();
            sincronizarStatusAnalise(lead); // → atualiza status na planilha (se estiver em Análise)
            renderKanban(currentPipeline);
        }

        // ====================================================================
        // 12. AUTO SAVE & MODAL DE LEADS
        // ====================================================================
        function setupAutoSaveListeners() {
            document.querySelectorAll('.auto-save-lead').forEach(input => {
                input.addEventListener('change', autoSaveLeadDetails);
                if(input.tagName === 'INPUT' && input.type !== 'checkbox' && input.type !== 'file') 
                    input.addEventListener('keyup', debounce(autoSaveLeadDetails, 800));
                if(input.tagName === 'TEXTAREA') 
                    input.addEventListener('keyup', debounce(autoSaveLeadDetails, 1000));
            });
            
            document.querySelectorAll('.auto-save-prof').forEach(input => {
                input.addEventListener('change', autoSaveProfile);
                if(input.tagName === 'INPUT') 
                    input.addEventListener('keyup', debounce(autoSaveProfile, 800));
            });
        }

        function autoSaveLeadDetails() {
            const id = document.getElementById('ld-id').value; 
            if(!id) return;
            const lead = DB.leads.find(l => l.id === id); 
            if(!lead) return;

            // Campos monetários: converter R$ mascarado para número
            const currencyFields = { vgv: 'ld-vgv', commissionValue: 'ld-commission-value', propertyValue: 'ld-property-value', valorBonus: 'ld-valorBonus', bonusRecebido: 'ld-bonusRecebido' };
            Object.entries(currencyFields).forEach(([field, elId]) => {
                const el = document.getElementById(elId);
                if(el && !el.disabled) lead[field] = parseCurrency(el.value);
            });

            // Campos textuais
            ['phone','cpf','city','email','broker','income','fgts','dependents','score','entry','project','construtora','type','mcmv','subsidy','opObs','origin','vendaSituacao','temBonus','bonusBeneficiario','bonusPctNota','bonusDataRecebido'].forEach(f => {
                const el = document.getElementById(`ld-${f}`);
                if(el && !el.disabled) lead[f] = el.value;
            });
            const bonusDataEl = document.getElementById('ld-bonusDataRecebido');
            if(bonusDataEl && !bonusDataEl.disabled) lead.bonusDataRecebido = bonusDataEl.value;

            const fuEl = document.getElementById('ld-followUp');
            if(fuEl) lead.followUp = fuEl.value ? new Date(fuEl.value).toISOString() : '';

            // Nome do cliente (editável) — atualiza o nome e o cabeçalho
            const nameInput = document.getElementById('ld-clientname');
            if(nameInput && nameInput.value.trim() && nameInput.value !== lead.name) {
                lead.name = nameInput.value.trim();
                const nameH = document.getElementById('ld-name');
                if(nameH) { const fi = followUpInfo(lead.followUp); const fs = fi ? `<span class="text-[11px] px-2.5 py-1 rounded font-bold ml-2 align-middle ${fi.overdue?'bg-red-500 text-white':'bg-blue-600 text-white'}"><i class="fa-solid fa-clock mr-1"></i>${fi.text}</span>` : ''; nameH.innerHTML = `${lead.numId ? '<span class="text-blue-400 text-lg align-middle mr-1">'+formatNumId(lead.numId)+'</span>' : ''}${lead.name}${fs}`; }
                const av = document.getElementById('ld-avatar');
                if(av) av.innerText = lead.name.substring(0,2).toUpperCase();
            }

            // Registrar última alteração
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;

            saveLeadsDB();
            // Sincroniza se o lead está em Análise/Financeiro OU se já estava na planilha
            if(['analise','financeiro'].includes(lead.pipeline) || lead.naPlanilha) sincronizarPlanilha(lead);
            triggerAutoSaveUI('save-ind-lead');
        }

        function autoSaveProfile() {
            currentUser.name = document.getElementById('prof-name').value;
            currentUser.phone = document.getElementById('prof-phone').value;
            currentUser.email = document.getElementById('prof-email').value;
            currentUser.role = document.getElementById('prof-role').value;
            currentUser.team = document.getElementById('prof-team').value;
            currentUser.goal = document.getElementById('prof-goal').value;
            currentUser.commission = document.getElementById('prof-commission').value;
            
            const idx = DB.users.findIndex(u => u.id === currentUser.id);
            if(idx !== -1) { DB.users[idx] = currentUser; saveUsersDB(); }
            localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(currentUser));
            
            triggerAutoSaveUI('save-ind-profile');
            setupUIForUser();
            
            document.getElementById('prof-display-name').innerText = currentUser.name;
            document.getElementById('prof-display-role').innerText = currentUser.role;
        }

        function loadProfileForm() {
            if(!currentUser) return;
            document.getElementById('prof-name').value = currentUser.name || '';
            document.getElementById('prof-phone').value = currentUser.phone || '';
            document.getElementById('prof-email').value = currentUser.email || '';
            document.getElementById('prof-role').value = currentUser.role || 'Corretor';
            document.getElementById('prof-team').value = currentUser.team || '';
            document.getElementById('prof-goal').value = currentUser.goal || '';
            document.getElementById('prof-commission').value = currentUser.commission || '';
            document.getElementById('prof-display-name').innerText = currentUser.name;
            document.getElementById('prof-display-role').innerText = currentUser.role;
            
            // Restrições por cargo
            if(currentUser.role !== 'Diretor') {
                document.getElementById('prof-role').disabled = true;
            }
        }

        function renderProfileStats() {
            const myLeads = currentUser.role === 'Corretor' 
                ? DB.leads.filter(l => l.broker === currentUser.name).length
                : DB.leads.length;
            const conversions = (currentUser.role === 'Corretor' 
                ? DB.leads.filter(l => l.broker === currentUser.name && l.pipeline === 'financeiro').length
                : DB.leads.filter(l => l.pipeline === 'financeiro').length);
            document.getElementById('prof-stat-leads').textContent = myLeads;
            document.getElementById('prof-stat-conv').textContent = conversions;
        }

        window.handlePhotoUpload = function(event) {
            const file = event.target.files[0]; if(!file) return;
            if(file.size > 1024 * 1024) { showToast('Imagem muito grande (máx 1MB)', 'error'); return; }
            const reader = new FileReader();
            reader.onload = (e) => {
                currentUser.photo = e.target.result;
                const idx = DB.users.findIndex(u => u.id === currentUser.id);
                if(idx !== -1) { DB.users[idx] = currentUser; saveUsersDB(); }
                localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(currentUser));
                updateUserAvatars();
                showToast('Foto atualizada!', 'success');
            };
            reader.readAsDataURL(file);
        }

        function debounce(func, wait) {
            let timeout; 
            return function executedFunction(...args) { 
                const later = () => { clearTimeout(timeout); func(...args); }; 
                clearTimeout(timeout); 
                timeout = setTimeout(later, wait); 
            };
        }

        window.openNewLeadModal = function() {
            const select = document.getElementById('nl-broker');
            if(currentUser.role === 'Corretor') { 
                select.value = currentUser.name; 
                select.disabled = true; 
            } else { 
                select.disabled = false; 
            }
            const modal = document.getElementById('modal-new-lead');
            modal.classList.remove('hidden');
            setTimeout(() => { 
                modal.classList.remove('opacity-0'); 
                document.getElementById('modal-new-lead-content').classList.remove('scale-95'); 
                document.getElementById('nl-name').focus();
            }, 10);
        }

        function setupForms() {
            const formNL = document.getElementById('form-new-lead');
            if(formNL.dataset.bound === '1') return; // evita anexar o listener 2x (duplicação de leads)
            formNL.dataset.bound = '1';
            formNL.addEventListener('submit', function(e) {
                e.preventDefault();
                const t = getTime();
                const phone = document.getElementById('nl-phone').value;
                
                // Validação
                if(phone.replace(/\D/g,'').length < 10) {
                    showToast('Telefone inválido', 'error');
                    document.getElementById('nl-phone').classList.add('error');
                    return;
                }
                
                // Determina broker: se for corretor, sempre o próprio; se for gerente sem seleção, próprio; senão valor do select
                let leadBroker;
                if(currentUser.role === 'Corretor') {
                    leadBroker = currentUser.name;
                } else if(currentUser.role === 'Gerente') {
                    const selected = document.getElementById('nl-broker').value;
                    leadBroker = (!selected || selected === 'Não Atribuído') ? currentUser.name : selected;
                } else {
                    leadBroker = document.getElementById('nl-broker').value;
                }

                const now = new Date().toISOString();
                const isDistribuir = window._pendingDistribuir ||
                    (currentView === 'distribuir') ||
                    (!leadBroker || leadBroker === 'Não Atribuído');
                window._pendingDistribuir = false;
                const newLead = {
                    id: generateId(),
                    numId: nextNumId(),
                    name: document.getElementById('nl-name').value,
                    phone: phone,
                    email: document.getElementById('nl-email').value,
                    origin: document.getElementById('nl-origin').value,
                    income: document.getElementById('nl-income').value,
                    broker: leadBroker,
                    followUp: (()=>{ const v = document.getElementById('nl-followUp')?.value; return v ? new Date(v).toISOString() : new Date().toISOString(); })(),
                    pipeline: isDistribuir ? 'distribuicao' : 'leads',
                    stageId: isDistribuir ? 'a-distribuir' : 'aguardando',
                    order: 0,
                    docs: [], files: [],
                    timeline: [`[${t}] Lead criado por ${currentUser.name}${isDistribuir ? ' — aguardando distribuição' : ''}`],
                    date: getDateStr(),
                    createdAt: now,
                    updatedAt: now,
                    updatedBy: currentUser.name,
                    opObs: '',
                    vgv: 0, commissionValue: 0, saleDate: null
                };
                
                const obs = document.getElementById('nl-obs').value; 
                if(obs) {
                    newLead.opObs = obs;
                    newLead.timeline.unshift(`[${t}] Observação inicial cadastrada`);
                }
                
                if (leadBroker && leadBroker !== 'Não Atribuído') { 
                    newLead.timeline.unshift(`[${t}] Atribuído a ${leadBroker}`); 
                }
                
                DB.leads.push(newLead);
                saveLeadsDB();
                closeModal('modal-new-lead');
                this.reset();
                if(newLead.pipeline === 'distribuicao') {
                    showToast(`Lead "${newLead.name}" adicionado à fila de distribuição!`, 'success');
                    addNotification(`Novo lead aguardando distribuição: ${newLead.name}`, 'warning');
                    navigate('distribuir');
                } else {
                    showToast('Lead criado com sucesso!', 'success');
                    addNotification(`Novo lead: ${newLead.name}`, 'success');
                    if(currentView === 'leads') renderKanban('leads');
                }
            });
            
            // Password strength
            const pwdNew = document.getElementById('pwd-new');
            if(pwdNew) {
                pwdNew.addEventListener('input', (e) => {
                    const v = e.target.value;
                    let strength = 0;
                    if(v.length >= 6) strength += 25;
                    if(v.length >= 10) strength += 25;
                    if(/[A-Z]/.test(v)) strength += 25;
                    if(/[0-9]/.test(v) || /[^A-Za-z0-9]/.test(v)) strength += 25;
                    
                    const bar = document.getElementById('pwd-strength');
                    const text = document.getElementById('pwd-strength-text');
                    bar.style.width = strength + '%';
                    if(strength <= 25) { bar.style.background = '#ef4444'; text.textContent = 'Fraca'; }
                    else if(strength <= 50) { bar.style.background = '#f59e0b'; text.textContent = 'Média'; }
                    else if(strength <= 75) { bar.style.background = '#3b82f6'; text.textContent = 'Boa'; }
                    else { bar.style.background = '#10b981'; text.textContent = 'Forte'; }
                });
            }
        }

        window.openChangePasswordModal = function() {
            document.getElementById('form-password').reset();
            document.getElementById('pwd-strength').style.width = '0%';
            const modal = document.getElementById('modal-password');
            modal.classList.remove('hidden');
            setTimeout(() => { 
                modal.classList.remove('opacity-0'); 
                document.getElementById('modal-password-content').classList.remove('scale-95'); 
            }, 10);
        }

        window.handlePasswordChange = async function(e) {
            e.preventDefault();
            const current = document.getElementById('pwd-current').value;
            const newPwd = document.getElementById('pwd-new').value;
            const confirm = document.getElementById('pwd-confirm').value;

            if(current !== currentUser.pass) { showToast('Senha atual incorreta', 'error'); return; }
            if(newPwd !== confirm) { showToast('Senhas não conferem', 'error'); return; }
            if(newPwd.length < 6) { showToast('A senha deve ter ao menos 6 caracteres', 'error'); return; }

            // Atualiza a senha OFICIAL (Supabase Auth) — o usuário está logado, então pode trocar a própria
            try {
                const { error } = await _sb.auth.updateUser({ password: newPwd });
                if(error) throw error;
            } catch(err) {
                showToast('Não foi possível alterar a senha: ' + (err.message || ''), 'error');
                return;
            }

            // Mantém o campo legado (tabela) em sincronia
            currentUser.pass = newPwd;
            const idx = DB.users.findIndex(u => u.id === currentUser.id);
            if(idx !== -1) { DB.users[idx] = currentUser; saveUsersDB(); }
            localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(currentUser));

            closeModal('modal-password');
            showToast('Senha atualizada com sucesso!', 'success');
            addNotification('Senha alterada com sucesso', 'info');
        }

        // ====================================================================
        // 13. MODAL DO LEAD (ABAS, DADOS, CHECKLIST E ARQUIVOS)
        // ====================================================================
        window.switchLeadTab = function(tabName, event) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            
            if(event && event.currentTarget) event.currentTarget.classList.add('active');
            document.getElementById(`tab-${tabName}`).classList.add('active');
        }

        // Sequência de navegação CONGELADA: lista de IDs capturada ao abrir um lead fresco.
        // A ordenação do kanban pode mudar em tempo real, mas a navegação Anterior/Próximo
        // segue esta lista até o usuário abrir outro lead direto do kanban ou recarregar.
        let _navSequence = [];

        // Resolve os IDs congelados em objetos de lead (ignora os que não existem mais)
        function _navColResolved() {
            return _navSequence.map(id => DB.leads.find(l => l.id === id)).filter(Boolean);
        }

        // Retorna os leads da mesma coluna (mesmo pipeline + etapa) que o lead, na ordem do kanban
        function leadsNaColuna(lead) {
            if(!lead) return [];
            if(lead.pipeline === 'cancelados') {
                return DB.leads.filter(l => l.pipeline === 'cancelados');
            }
            let base = getVisibleLeads().filter(l => l.pipeline === lead.pipeline && l.stageId === lead.stageId);
            // aplica os mesmos filtros do kanban, se a função existir
            try { base = applyKanbanFilters(base); } catch(e) {}
            // Mesma ordenação do kanban: urgência do follow-up (vencido/próximo no topo)
            return base.sort((a, b) => {
                const fa = a.followUp ? new Date(a.followUp).getTime() : Infinity;
                const fb = b.followUp ? new Date(b.followUp).getTime() : Infinity;
                if(fa !== fb) return fa - fb;
                return (a.order||0) - (b.order||0);
            });
        }

        // Reflete o estado Hot no botão do cabeçalho do lead
        function atualizarBotaoHot(lead) {
            const btn = document.getElementById('ld-hot-btn');
            if(!btn) return;
            if(lead && lead.hot) {
                btn.classList.add('bg-orange-500/20','text-orange-400');
                btn.classList.remove('text-slate-500');
                btn.title = 'Remover destaque Hot';
            } else {
                btn.classList.remove('bg-orange-500/20','text-orange-400');
                btn.classList.add('text-slate-500');
                btn.title = 'Marcar como Hot';
            }
        }

        // Liga/desliga o destaque Hot do lead aberto
        window.toggleHotLead = function(e) {
            if(e) e.stopPropagation();
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            lead.hot = !lead.hot;
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;
            saveLeadsDB();
            atualizarBotaoHot(lead);
            showToast(lead.hot ? '🔥 Lead marcado como Hot!' : 'Destaque Hot removido.', lead.hot ? 'success' : 'info');
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
        }

        // Recarrega o BI embarcado (reseta o iframe e mostra o loader)
        window.recarregarBI = function() {
            const iframe = document.getElementById('bi-iframe');
            const loader = document.getElementById('bi-loader');
            if(loader) loader.classList.remove('opacity-0','pointer-events-none');
            if(iframe) iframe.src = iframe.src;
        }

        // Recarrega a Agenda embarcada (reseta o iframe e mostra o loader)
        window.recarregarAgenda = function() {
            const iframe = document.getElementById('agenda-iframe');
            const loader = document.getElementById('agenda-loader');
            if(loader) loader.classList.remove('opacity-0','pointer-events-none');
            if(iframe) iframe.src = iframe.src;
        }

        // Copia o nome do cliente do lead aberto para a área de transferência
        window.copiarNomeCliente = function(e) {
            if(e) e.stopPropagation();
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            const nome = (lead?.name || document.getElementById('ld-clientname')?.value || '').trim();
            if(!nome) { showToast('Nome do cliente vazio.', 'warning'); return; }
            const feedback = () => {
                showToast('Nome copiado: ' + nome, 'success');
                const btn = document.getElementById('ld-copy-name');
                if(btn) {
                    const icon = btn.querySelector('i');
                    if(icon) { icon.className = 'fa-solid fa-check text-[11px] text-emerald-400'; setTimeout(() => { icon.className = 'fa-regular fa-copy text-[11px]'; }, 1500); }
                }
            };
            if(navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(nome).then(feedback).catch(() => {
                    const t = document.createElement('textarea'); t.value = nome; document.body.appendChild(t); t.select();
                    try { document.execCommand('copy'); feedback(); } catch(_) { showToast('Não foi possível copiar.', 'error'); }
                    document.body.removeChild(t);
                });
            } else {
                const t = document.createElement('textarea'); t.value = nome; document.body.appendChild(t); t.select();
                try { document.execCommand('copy'); feedback(); } catch(_) { showToast('Não foi possível copiar.', 'error'); }
                document.body.removeChild(t);
            }
        }

        // Navega para o lead anterior/próximo — usa a SEQUÊNCIA CONGELADA (não recalcula)
        window.navegarLead = function(dir) {
            const id = document.getElementById('ld-id').value;
            const atual = DB.leads.find(l => l.id === id);
            if(!atual) return;
            let col = _navColResolved();
            let idx = col.findIndex(l => l.id === id);
            // Se o lead atual saiu da sequência congelada (raro), reccongelar a partir da coluna atual
            if(idx === -1) {
                _navSequence = leadsNaColuna(atual).map(l => l.id);
                col = _navColResolved();
                idx = col.findIndex(l => l.id === id);
            }
            if(idx === -1) return;
            const novoIdx = dir === 'next' ? idx + 1 : idx - 1;
            if(novoIdx < 0 || novoIdx >= col.length) {
                showToast(dir === 'next' ? 'Último lead da sequência.' : 'Primeiro lead da sequência.', 'info');
                return;
            }
            openLeadDetails(col[novoIdx].id, true); // true = veio da navegação, mantém a sequência
        }

        // Atualiza os botões de navegação (posição X/Y e habilita/desabilita) — usa sequência congelada
        function atualizarNavLead(lead) {
            const col = _navColResolved();
            const idx = col.findIndex(l => l.id === lead.id);
            const pos = document.getElementById('ld-nav-pos');
            const prev = document.getElementById('ld-nav-prev');
            const next = document.getElementById('ld-nav-next');
            if(pos) pos.textContent = col.length > 1 ? `${idx+1}/${col.length}` : '';
            const setDis = (el, dis) => { if(!el) return; el.disabled = dis; el.style.opacity = dis ? '0.35' : '1'; el.style.pointerEvents = dis ? 'none' : 'auto'; };
            setDis(prev, idx <= 0);
            setDis(next, idx >= col.length - 1);
        }

        // ====================================================================
        // CONTROLE DE COMISSÃO (recebimentos do Ganho)
        // ====================================================================
        // ====================================================================
        // FATURAMENTO — comissões do GERENTE (recebido x falta) nos leads do Ganho
        // ====================================================================
        window.renderFaturamento = function() {
            const tbody = document.getElementById('fat-tbody');
            if(!tbody) return;
            const busca = (document.getElementById('fat-search')?.value || '').toLowerCase();

            // Só leads no Ganho (financeiro), respeitando a visibilidade do usuário
            let leads = getVisibleLeads().filter(l => l.pipeline === 'financeiro');
            if(busca) leads = leads.filter(l =>
                (l.name||'').toLowerCase().includes(busca) || (l.broker||'').toLowerCase().includes(busca)
            );

            let totPrevista = 0, totRecebido = 0, totFalta = 0, qtdIntegral = 0;
            const dadosLead = (l) => {
                const total = l.comissaoGerente || 0;
                const recebido = (l.recebimentos || []).filter(r => r.tipo === 'Gerente').reduce((s,r) => s + (r.valor||0), 0);
                const falta = Math.max(0, total - recebido);
                const integral = (l.stageId === 'recebido-integral') || (total > 0 && falta === 0);
                return { total, recebido, falta, integral };
            };
            const linhaLead = (l) => {
                const { total, recebido, falta, integral } = dadosLead(l);
                let statusBadge;
                if(integral) statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30"><i class="fa-solid fa-flag-checkered text-[9px]"></i>Faturado Total</span>';
                else if(recebido > 0) statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">Parcial</span>';
                else statusBadge = '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-600/30 text-slate-400 border border-slate-600/40">Pendente</span>';
                return `<tr class="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors cursor-pointer" onclick="openLeadDetails('${l.id}')">
                    <td class="py-2.5 px-4 pl-8">
                        <div class="font-bold text-white text-sm">${l.numId ? '<span class="text-blue-400/70 text-[11px] mr-1">'+formatNumId(l.numId)+'</span>' : ''}${l.name}</div>
                        <div class="text-[11px] text-slate-500">${l.broker || '—'}</div>
                    </td>
                    <td class="py-2.5 px-4 text-right text-sm font-bold text-white">${formatCurrency(total)}</td>
                    <td class="py-2.5 px-4 text-right text-sm font-bold text-emerald-400">${formatCurrency(recebido)}</td>
                    <td class="py-2.5 px-4 text-right text-sm font-bold ${falta > 0 ? 'text-amber-300' : 'text-slate-500'}">${formatCurrency(falta)}</td>
                    <td class="py-2.5 px-4 text-center">${statusBadge}</td>
                </tr>`;
            };

            // Agrupa por ETAPA do Ganho, na ordem do pipeline
            let html = '';
            PIPELINES.financeiro.forEach(stage => {
                const doStage = leads.filter(l => l.stageId === stage.id);
                if(doStage.length === 0) return;
                let sTotal = 0, sRec = 0, sFalta = 0;
                doStage.forEach(l => { const d = dadosLead(l); sTotal += d.total; sRec += d.recebido; sFalta += d.falta; if(d.integral) qtdIntegral++; });
                totPrevista += sTotal; totRecebido += sRec; totFalta += sFalta;
                const cor = stage.color.replace('border-l-','bg-');
                // Cabeçalho da etapa (com subtotais)
                html += `<tr class="bg-slate-900/50">
                    <td class="py-2.5 px-4">
                        <span class="inline-flex items-center gap-2 text-xs font-bold text-slate-200 uppercase tracking-wider"><span class="w-2.5 h-2.5 rounded-full ${cor}"></span>${stage.title}<span class="text-slate-500 font-semibold normal-case tracking-normal">· ${doStage.length}</span></span>
                    </td>
                    <td class="py-2.5 px-4 text-right text-[11px] font-bold text-slate-400">${formatCurrency(sTotal)}</td>
                    <td class="py-2.5 px-4 text-right text-[11px] font-bold text-emerald-400/80">${formatCurrency(sRec)}</td>
                    <td class="py-2.5 px-4 text-right text-[11px] font-bold text-amber-300/80">${formatCurrency(sFalta)}</td>
                    <td class="py-2.5 px-4"></td>
                </tr>`;
                html += doStage.map(linhaLead).join('');
            });

            tbody.innerHTML = html || '<tr><td colspan="5" class="py-16 text-center text-slate-500"><i class="fa-regular fa-folder-open text-3xl mb-3 block opacity-50"></i>Nenhuma venda no Ganho ainda.</td></tr>';

            const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent = v; };
            set('fat-prevista', formatCurrency(totPrevista));
            set('fat-recebido', formatCurrency(totRecebido));
            set('fat-falta', formatCurrency(totFalta));
            set('fat-qtd', leads.length);
            set('fat-recebido-pct', (totPrevista > 0 ? Math.round(totRecebido/totPrevista*100) : 0) + '%');
            set('fat-integral-qtd', qtdIntegral);

            // ===== Recebimentos por Mês (comissão do gerente, pela data de cada recebimento) =====
            const meses = {}; // chave = rótulo do mês -> { total, itens:[{data, dataOrd, valor, cliente}] }
            leads.forEach(l => {
                (l.recebimentos || []).filter(r => r.tipo === 'Gerente').forEach(r => {
                    const dt = _parseDataQualquer(r.data);
                    const rotulo = r.data ? labelMesComercial(r.data) : 'Sem data';
                    if(!meses[rotulo]) meses[rotulo] = { total: 0, ord: dt ? dt.getTime() : Infinity, itens: [] };
                    meses[rotulo].total += (r.valor || 0);
                    if(dt && dt.getTime() < meses[rotulo].ord) meses[rotulo].ord = dt.getTime();
                    meses[rotulo].itens.push({ dataOrd: dt ? dt.getTime() : 0, data: r.data || '—', valor: r.valor || 0, cliente: l.name });
                });
            });
            const mesesCont = document.getElementById('fat-meses');
            if(mesesCont) {
                const ordenados = Object.entries(meses).sort((a,b) => a[1].ord - b[1].ord);
                if(ordenados.length === 0) {
                    mesesCont.innerHTML = '<div class="glass p-5 rounded-2xl border border-slate-700/50 text-sm text-slate-500 md:col-span-3 text-center"><i class="fa-regular fa-calendar text-2xl block mb-2 opacity-50"></i>Nenhum recebimento de gerente registrado ainda.</div>';
                } else {
                    mesesCont.innerHTML = ordenados.map(([rotulo, m]) => {
                        const itens = m.itens.sort((a,b) => a.dataOrd - b.dataOrd).map(it => `
                            <div class="flex items-center justify-between text-xs py-1.5 border-b border-slate-800/60 last:border-0">
                                <span class="text-slate-400"><i class="fa-solid fa-calendar-day text-[9px] text-slate-600 mr-1.5"></i>${it.data}</span>
                                <span class="text-slate-300 truncate max-w-[130px] mx-2">${it.cliente}</span>
                                <span class="text-emerald-400 font-bold whitespace-nowrap">${formatCurrency(it.valor)}</span>
                            </div>`).join('');
                        return `<div class="glass p-4 rounded-2xl border border-slate-700/50">
                            <div class="flex items-center justify-between mb-3 pb-2 border-b border-slate-700/50">
                                <span class="text-sm font-bold text-white capitalize">${rotulo}</span>
                                <span class="text-emerald-400 font-bold text-sm">${formatCurrency(m.total)}</span>
                            </div>
                            <div class="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">${m.itens.length} recebimento${m.itens.length>1?'s':''}</div>
                            <div>${itens}</div>
                        </div>`;
                    }).join('');
                }
            }
        }

        function renderControleComissao(lead) {
            const resumo = document.getElementById('ld-comissao-resumo');
            const lista = document.getElementById('ld-receb-lista');
            if(!resumo || !lista) return;
            lead.recebimentos = lead.recebimentos || [];

            const totalCorretor = lead.commissionBroker || 0;
            const totalGerente = lead.comissaoGerente || 0;
            const recCorretor = lead.recebimentos.filter(r => r.tipo === 'Corretor').reduce((s,r) => s + (r.valor||0), 0);
            const recGerente = lead.recebimentos.filter(r => r.tipo === 'Gerente').reduce((s,r) => s + (r.valor||0), 0);

            const card = (titulo, total, recebido, cor) => {
                const falta = Math.max(0, total - recebido);
                const pct = total > 0 ? Math.min(100, Math.round(recebido/total*100)) : 0;
                return `<div class="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
                    <p class="text-[11px] font-bold ${cor} uppercase tracking-wider mb-1">${titulo}</p>
                    <p class="text-xs text-slate-400">Total: <b class="text-white">${formatCurrency(total)}</b></p>
                    <p class="text-xs text-slate-400">Recebido: <b class="text-emerald-400">${formatCurrency(recebido)}</b></p>
                    <p class="text-xs text-slate-400">Falta: <b class="text-amber-400">${formatCurrency(falta)}</b></p>
                    <div class="lead-progress-track mt-2"><div class="lead-progress-fill" style="width:${pct}%; background-color:#10b981"></div></div>
                </div>`;
            };
            resumo.innerHTML = card('Corretor', totalCorretor, recCorretor, 'text-blue-300') + card('Gerente', totalGerente, recGerente, 'text-purple-300');

            if(lead.recebimentos.length === 0) {
                lista.innerHTML = '<p class="text-xs text-slate-500 italic py-1">Nenhum recebimento registrado.</p>';
            } else {
                lista.innerHTML = lead.recebimentos.slice().reverse().map(r => `
                    <div class="flex items-center justify-between bg-slate-800/40 border border-slate-700/40 rounded-lg px-3 py-2">
                        <div class="text-sm">
                            <span class="font-bold ${r.tipo === 'Corretor' ? 'text-blue-300' : 'text-purple-300'}">${r.tipo}</span>
                            <span class="text-emerald-400 font-bold ml-2">${formatCurrency(r.valor)}</span>
                            <span class="text-slate-500 text-xs ml-2">${r.data || ''}</span>
                        </div>
                        <button onclick="removeRecebimento('${r.id}')" class="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1.5 rounded"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>`).join('');
            }
        }

        // Retorna a lista de bônus do lead, migrando do formato antigo (bônus único) se preciso
        function _bonusesDoLead(lead) {
            if(Array.isArray(lead.bonuses)) return lead.bonuses;
            if(lead.temBonus === 'Sim' && (lead.valorBonus || lead.bonusRecebido)) {
                lead.bonuses = [{
                    id: generateId(),
                    beneficiario: lead.bonusBeneficiario || 'Corretor',
                    valor: lead.valorBonus || 0,
                    pctNota: lead.bonusPctNota || 0,
                    recebido: lead.bonusRecebido || 0,
                    data: lead.bonusDataRecebido || ''
                }];
            } else {
                lead.bonuses = [];
            }
            return lead.bonuses;
        }

        // Mostra/esconde o painel de bônus conforme Sim/Não
        window.toggleBonus = function() {
            const sel = document.getElementById('ld-temBonus');
            const panel = document.getElementById('ld-bonus-panel');
            if(!sel || !panel) return;
            if(sel.value === 'Sim') {
                panel.classList.remove('hidden');
                const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value);
                if(lead) renderBonuses(lead);
            } else {
                panel.classList.add('hidden');
            }
        }
        // mantida por compatibilidade (chamadas antigas) — sem efeito
        window.recalcBonus = function() {};

        // Renderiza a lista de bônus + resumo somado
        window.renderBonuses = function(lead) {
            const lista = document.getElementById('ld-bonus-lista');
            if(!lista) return;
            const bonuses = _bonusesDoLead(lead);
            let totLiq = 0, totRec = 0;
            bonuses.forEach(b => { const v=b.valor||0, p=b.pctNota||0; totLiq += v-(v*p/100); totRec += b.recebido||0; });
            const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=formatCurrency(v); };
            set('ld-bonus-liquido-display', totLiq);
            set('ld-bonus-recebido-display', totRec);
            set('ld-bonus-falta-display', Math.max(0, totLiq-totRec));

            if(bonuses.length === 0) {
                lista.innerHTML = '<p class="text-xs text-slate-500 italic py-1">Nenhum bônus adicionado.</p>';
                return;
            }
            lista.innerHTML = bonuses.slice().reverse().map(b => {
                const v=b.valor||0, p=b.pctNota||0; const liq=v-(v*p/100); const falta=Math.max(0,liq-(b.recebido||0));
                const dataBR = b.data ? String(b.data).split('-').reverse().join('/') : '';
                return `<div class="flex items-center justify-between bg-slate-800/40 border border-slate-700/40 rounded-lg px-3 py-2 gap-2">
                    <div class="text-sm min-w-0">
                        <span class="font-bold ${b.beneficiario === 'Gerente' ? 'text-purple-300' : 'text-blue-300'}">${b.beneficiario||'—'}</span>
                        <span class="text-emerald-400 font-bold ml-2">${formatCurrency(liq)}</span>
                        <span class="text-slate-500 text-xs ml-1">líq.</span>
                        <span class="text-[11px] text-slate-500 ml-2">rec. ${formatCurrency(b.recebido||0)} · falta ${formatCurrency(falta)}${dataBR ? ' · '+dataBR : ''}</span>
                    </div>
                    <button onclick="removeBonus('${b.id}')" class="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1.5 rounded flex-shrink-0"><i class="fa-solid fa-trash text-xs"></i></button>
                </div>`;
            }).join('');
        }

        window.addBonus = function() {
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value);
            if(!lead) return;
            const beneficiario = document.getElementById('ld-bonus-add-benef').value;
            const valor = parseCurrency(document.getElementById('ld-bonus-add-valor').value);
            const pctNota = parseFloat(document.getElementById('ld-bonus-add-pct').value) || 0;
            const recebido = parseCurrency(document.getElementById('ld-bonus-add-receb').value) || 0;
            const data = document.getElementById('ld-bonus-add-data').value;
            if(!valor || valor <= 0) { showToast('Informe o valor do bônus.', 'error'); return; }
            _bonusesDoLead(lead);
            lead.bonuses.push({ id: generateId(), beneficiario, valor, pctNota, recebido, data });
            lead.timeline = lead.timeline || [];
            lead.timeline.unshift(`[${getTime()}] Bônus adicionado (${beneficiario}): ${formatCurrency(valor)}`);
            saveLeadsDB();
            sincronizarPlanilha(lead);
            // limpa o formulário
            document.getElementById('ld-bonus-add-valor').value = '';
            document.getElementById('ld-bonus-add-pct').value = '';
            document.getElementById('ld-bonus-add-receb').value = '';
            document.getElementById('ld-bonus-add-data').value = '';
            renderBonuses(lead);
            renderTimeline(lead);
            showToast('Bônus adicionado!', 'success');
        }

        window.removeBonus = function(bid) {
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value);
            if(!lead || !Array.isArray(lead.bonuses)) return;
            if(!confirm('Remover este bônus?')) return;
            lead.bonuses = lead.bonuses.filter(b => b.id !== bid);
            saveLeadsDB();
            sincronizarPlanilha(lead);
            renderBonuses(lead);
            showToast('Bônus removido.', 'info');
        }

        window.addRecebimento = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            const tipo = document.getElementById('ld-receb-tipo').value;
            const valor = parseCurrency(document.getElementById('ld-receb-valor').value);
            const data = document.getElementById('ld-receb-data').value;
            if(!valor || valor <= 0) { showToast('Informe o valor recebido.', 'error'); return; }
            lead.recebimentos = lead.recebimentos || [];
            const dataFmt = data ? data.split('-').reverse().join('/') : getDateStr();
            lead.recebimentos.push({ id: generateId(), tipo, valor, data: dataFmt, registradoPor: currentUser.name });
            lead.timeline = lead.timeline || [];
            lead.timeline.unshift(`[${getTime()}] Recebimento de comissão (${tipo}): ${formatCurrency(valor)}`);
            saveLeadsDB();
            sincronizarPlanilha(lead); // atualiza recebimentos na planilha
            document.getElementById('ld-receb-valor').value = '';
            document.getElementById('ld-receb-data').value = '';
            renderControleComissao(lead);
            renderTimeline(lead);
            showToast('Recebimento registrado!', 'success');
        }

        window.removeRecebimento = function(rid) {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead || !lead.recebimentos) return;
            if(!confirm('Remover este recebimento?')) return;
            lead.recebimentos = lead.recebimentos.filter(r => r.id !== rid);
            saveLeadsDB();
            sincronizarPlanilha(lead);
            renderControleComissao(lead);
            showToast('Recebimento removido.', 'info');
        }

        window.openLeadDetails = function(id, fromNav) {
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;

            // Abertura FRESCA (do kanban, busca, etc.): congela a sequência de navegação agora.
            // Abertura via Anterior/Próximo (fromNav=true): mantém a sequência já congelada.
            if(!fromNav) {
                _navSequence = leadsNaColuna(lead).map(l => l.id);
            }

            document.getElementById('ld-id').value = lead.id;
            document.getElementById('ld-date').innerText = lead.date || getDateStr();
            
            const fuInfo = followUpInfo(lead.followUp);
            const fuSpan = fuInfo
                ? `<span id="ld-fu-badge" class="text-[11px] px-2.5 py-1 rounded font-bold ml-2 align-middle ${fuInfo.overdue ? 'bg-red-500 text-white' : 'bg-blue-600 text-white'}"><i class="fa-solid fa-clock mr-1"></i>${fuInfo.text}</span><button onclick="openFollowUpPicker(event,'${lead.id}')" class="text-[11px] px-2.5 py-1 rounded font-bold ml-1 align-middle bg-slate-700 hover:bg-blue-600 text-slate-300 hover:text-white transition-all"><i class="fa-solid fa-clock mr-1"></i>Follow-up</button>`
                : `<button onclick="openFollowUpPicker(event,'${lead.id}')" class="text-[11px] px-2.5 py-1 rounded font-medium ml-2 align-middle bg-slate-700 hover:bg-blue-600 text-slate-400 hover:text-white transition-all"><i class="fa-solid fa-calendar-plus mr-1"></i>Follow-up</button>`;
            document.getElementById('ld-name').innerHTML = `${lead.numId ? '<span class="text-blue-400 text-lg align-middle mr-1">'+formatNumId(lead.numId)+'</span>' : ''}${lead.name}${fuSpan}`;
            document.getElementById('ld-avatar').innerText = lead.name.substring(0,2).toUpperCase();
            
            document.getElementById('ld-pipeline-select').value = lead.pipeline; 
            handleManualPipelineChange(lead.stageId);

            // Atualizar badges visuais (display-only)
            const pipeNames = { leads: 'Leads', analise: 'Análise de Crédito', financeiro: 'Ganhos / Financeiro' };
            const pipeColors = { leads: 'bg-blue-500/20 text-blue-300 border-blue-500/40', analise: 'bg-purple-500/20 text-purple-300 border-purple-500/40', financeiro: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', cancelados: 'bg-red-500/20 text-red-300 border-red-500/40' };
            const stageName = PIPELINES[lead.pipeline]?.find(s => s.id === lead.stageId)?.title || lead.stageId;
            const pBadge = document.getElementById('ld-pipeline-badge');
            const sBadge = document.getElementById('ld-stage-badge');
            if(pBadge) { pBadge.textContent = pipeNames[lead.pipeline] || lead.pipeline; pBadge.className = 'text-xs font-bold rounded px-2.5 py-0.5 border whitespace-nowrap flex-shrink-0 ' + (pipeColors[lead.pipeline] || 'bg-slate-800 text-white border-slate-600'); }
            if(sBadge) sBadge.textContent = stageName;
            const brokerBadge = document.getElementById('ld-broker-badge');
            if(brokerBadge) {
                if(lead.broker && lead.broker !== 'Não Atribuído') {
                    brokerBadge.innerHTML = `<i class="fa-solid fa-user-tie mr-1.5"></i>${lead.broker}`;
                    brokerBadge.className = 'text-xs font-bold rounded px-2.5 py-0.5 border whitespace-nowrap flex-shrink-0 bg-slate-700/40 text-slate-200 border-slate-600';
                } else {
                    brokerBadge.className = 'hidden';
                }
            }
            const construtoraBadge = document.getElementById('ld-construtora-badge');
            if(construtoraBadge) {
                if(lead.construtora) {
                    construtoraBadge.innerHTML = `<i class="fa-solid fa-building mr-1.5"></i>${lead.construtora}`;
                    construtoraBadge.className = 'text-xs font-bold rounded px-2.5 py-0.5 border whitespace-nowrap flex-shrink-0 bg-amber-500/15 text-amber-300 border-amber-500/30';
                } else {
                    construtoraBadge.className = 'hidden';
                }
            }
            const empreendimentoBadge = document.getElementById('ld-empreendimento-badge');
            if(empreendimentoBadge) {
                if(lead.project) {
                    empreendimentoBadge.innerHTML = `<i class="fa-solid fa-city mr-1.5"></i>${lead.project}`;
                    empreendimentoBadge.className = 'text-xs font-bold rounded px-2.5 py-0.5 border whitespace-nowrap flex-shrink-0 bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
                } else {
                    empreendimentoBadge.className = 'hidden';
                }
            }

            // Preenche as listas (Construtora / Empreendimento) antes de setar os valores
            populateListaDropdowns(lead);

            // Nome do cliente (editável)
            const nameInput = document.getElementById('ld-clientname');
            if(nameInput) nameInput.value = lead.name || '';

            // Observação inicial / campanha (destaque)
            const obsBox = document.getElementById('ld-initial-obs-box');
            const obsText = document.getElementById('ld-initial-obs-text');
            if(obsBox && obsText) {
                if(lead.opObs && lead.opObs.trim()) { obsText.textContent = lead.opObs; obsBox.classList.remove('hidden'); }
                else obsBox.classList.add('hidden');
            }

            ['phone','cpf','city','email','broker','income','fgts','dependents','score','entry','project','construtora','type','mcmv','subsidy','opObs','origin','vendaSituacao','temBonus','bonusBeneficiario','bonusPctNota','bonusDataRecebido'].forEach(f => {
                const el = document.getElementById(`ld-${f}`);
                if(el) el.value = lead[f] || '';
            });
            // Campos monetários: aplicar formatação R$ ao carregar
            const propEl = document.getElementById('ld-property-value');
            if(propEl) propEl.value = formatCurrencyInput(lead.propertyValue || 0);
            const vgvEl = document.getElementById('ld-vgv');
            if(vgvEl) vgvEl.value = formatCurrencyInput(lead.vgv || 0);
            const commEl = document.getElementById('ld-commission-value');
            if(commEl) commEl.value = formatCurrencyInput(lead.commissionValue || 0);
            const bonusEl = document.getElementById('ld-valorBonus');
            if(bonusEl) bonusEl.value = formatCurrencyInput(lead.valorBonus || 0);
            const bonusRecEl = document.getElementById('ld-bonusRecebido');
            if(bonusRecEl) bonusRecEl.value = formatCurrencyInput(lead.bonusRecebido || 0);
            const bonusDataRecEl = document.getElementById('ld-bonusDataRecebido');
            if(bonusDataRecEl) bonusDataRecEl.value = lead.bonusDataRecebido || '';
            const bonusNotaEl = document.getElementById('ld-bonusPctNota');
            if(bonusNotaEl) bonusNotaEl.value = lead.bonusPctNota != null ? lead.bonusPctNota : '';
            toggleBonus(); // mostra/esconde o painel de bônus e recalcula
            const fuEl = document.getElementById('ld-followUp');
            if(fuEl) fuEl.value = lead.followUp ? new Date(lead.followUp).toISOString().slice(0,16) : '';

            // Pipeline display (oculto - mantido p/ compat) e Etapa editável
            const pipeDisplayNames = { leads: '📋 Leads', analise: '🔍 Análise de Crédito', financeiro: '💰 Ganhos / Financeiro', cancelados: '🚫 Cancelados' };
            const pipelineDisplay = document.getElementById('ld-pipeline-display');
            if(pipelineDisplay) pipelineDisplay.value = pipeDisplayNames[lead.pipeline] || lead.pipeline;

            // Etapa editável no HEADER (visível ao usuário)
            const stageHeader = document.getElementById('ld-stage-header');
            if(stageHeader && PIPELINES[lead.pipeline]) {
                const stages = PIPELINES[lead.pipeline];
                stageHeader.innerHTML = stages.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
                stageHeader.value = lead.stageId;
                // Desabilita para leads cancelados
                stageHeader.disabled = (lead.pipeline === 'cancelados');
            }

            // Mantém o select antigo sincronizado (oculto, compat)
            const stageEditable = document.getElementById('ld-stage-editable');
            if(stageEditable && PIPELINES[lead.pipeline]) {
                const stages = PIPELINES[lead.pipeline];
                stageEditable.innerHTML = stages.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
                stageEditable.value = lead.stageId;
            }

            // Aplicar máscaras nos novos campos abertos
            if(typeof setupMasks === 'function') setupMasks();

            // Popular campos de display (datas e equipe)
            const teamDisplay = document.getElementById('ld-team-display');
            if(teamDisplay) {
                const brokerUser = DB.users.find(u => u.name === lead.broker);
                teamDisplay.value = brokerUser?.team || '—';
            }
            const createdDisplay = document.getElementById('ld-created-display');
            if(createdDisplay) {
                if(lead.createdAt) {
                    createdDisplay.textContent = new Date(lead.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                } else if(lead.date) {
                    createdDisplay.textContent = lead.date;
                } else {
                    createdDisplay.textContent = '—';
                }
            }
            const updatedDisplay = document.getElementById('ld-updated-display');
            if(updatedDisplay) {
                updatedDisplay.textContent = lead.updatedAt 
                    ? new Date(lead.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) 
                    : 'Nunca';
            }
            const updatedByDisplay = document.getElementById('ld-updated-by-display');
            if(updatedByDisplay) updatedByDisplay.textContent = lead.updatedBy || '—';

            // Mostrar/esconder seção de Dados da Venda
            const saleSection = document.getElementById('ld-sale-section');
            if(saleSection) {
                if(lead.pipeline === 'financeiro') {
                    saleSection.classList.remove('hidden');
                    const info = document.getElementById('ld-sale-info');
                    if(info) {
                        const parts = [];
                        if(lead.saleDate) parts.push(`<i class="fa-solid fa-calendar-check text-emerald-400"></i> Venda registrada em <b class="text-white">${new Date(lead.saleDate).toLocaleDateString('pt-BR')}</b>`);
                        if(lead.updatedBy) parts.push(`<i class="fa-solid fa-user-pen text-blue-400"></i> Última edição: <b class="text-slate-300">${lead.updatedBy}</b> ${lead.updatedAt ? '· ' + new Date(lead.updatedAt).toLocaleString('pt-BR') : ''}`);
                        info.innerHTML = parts.length ? parts.join('<br>') : 'Sem histórico de venda registrado ainda.';
                    }
                    renderControleComissao(lead); // resumo + recebimentos de comissão
                } else {
                    saleSection.classList.add('hidden');
                }
            }
            
            const brokerSelect = document.getElementById('ld-broker');
            if(currentUser.role === 'Corretor') { 
                brokerSelect.disabled = true; 
            } else { 
                brokerSelect.disabled = false; 
            }
            
            // Switch to Tab 1
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.tab-btn').classList.add('active');
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById('tab-dados').classList.add('active');
            
            renderChecklist(lead);
            renderFiles(lead);
            renderTimeline(lead);
            renderLeadMessages(lead);
            updateProgressBar(lead);

            // Mostrar/esconder botões conforme contexto
            const moveBtn = document.getElementById('ld-move-btn');
            const cancelBtn = document.getElementById('ld-cancel-btn');
            const deleteBtn = document.getElementById('ld-delete-btn');
            if(lead.pipeline === 'cancelados') {
                // Lead cancelado: esconde Mover e Cancelar, mostra opção via mensagem
                if(moveBtn) moveBtn.classList.add('hidden');
                if(cancelBtn) cancelBtn.classList.add('hidden');
            } else {
                if(moveBtn) moveBtn.classList.remove('hidden');
                if(cancelBtn) {
                    cancelBtn.classList.remove('hidden');
                    if(!canCancelLead(lead)) cancelBtn.classList.add('hidden');
                }
            }
            // Exclusão definitiva removida do modal — somente via tela de Cancelados (Diretor)
            
            atualizarNavLead(lead); // setas de navegação entre leads da coluna
            atualizarBotaoHot(lead); // reflete o estado Hot no botão do cabeçalho

            const modal = document.getElementById('modal-lead-details');
            modal.classList.remove('hidden');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                document.getElementById('modal-lead-details-content').classList.remove('scale-95');
            }, 10);
        }

        window.handleManualPipelineChange = function(preselectedStageId = null) {
            const pipeId = document.getElementById('ld-pipeline-select').value;
            const stageSelect = document.getElementById('ld-stage-select'); 
            stageSelect.innerHTML = '';
            PIPELINES[pipeId].forEach(stage => { 
                const opt = document.createElement('option'); 
                opt.value = stage.id; 
                opt.textContent = stage.title; 
                stageSelect.appendChild(opt); 
            });
            if(preselectedStageId && typeof preselectedStageId === 'string') stageSelect.value = preselectedStageId;
            else if(!preselectedStageId && stageSelect.options.length > 0) autoSaveLeadDetails(); 
        }

        function updateProgressBar(lead) {
            const percent = lead.docs ? Math.round((lead.docs.length / DOC_CHECKLIST_ITEMS.length) * 100) : 0;
            document.getElementById('ld-progress-bar').style.width = percent + '%';
            document.getElementById('ld-progress-text').textContent = percent + '%';
            document.getElementById('checklist-percent').textContent = percent + '%';
            document.getElementById('docs-counter').textContent = (lead.files || []).length;
        }

        function renderChecklist(lead) {
            const container = document.getElementById('visual-checklist');
            container.innerHTML = '';
            if(!lead.docs) lead.docs = [];
            
            DOC_CHECKLIST_ITEMS.forEach(item => {
                const isChecked = lead.docs.includes(item.id);
                const colorClass = isChecked ? 'chk-approved' : 'chk-pending';
                const iconClass = isChecked ? 'fa-check-circle' : 'fa-clock';
                
                container.insertAdjacentHTML('beforeend', `
                    <label class="cursor-pointer flex items-center justify-between p-3 rounded-lg border transition-all ${colorClass}">
                        <input type="checkbox" class="hidden" value="${item.id}" onchange="toggleChecklistItem(this)" ${isChecked ? 'checked' : ''}>
                        <span class="font-bold">${item.label}</span>
                        <i class="fa-solid ${iconClass} text-lg"></i>
                    </label>
                `);
            });
        }

        window.toggleChecklistItem = function(checkboxEl) {
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value); 
            if(!lead) return;
            const val = checkboxEl.value;
            if(checkboxEl.checked) { 
                if(!lead.docs.includes(val)) lead.docs.push(val); 
                lead.timeline.unshift(`[${getTime()}] Documento aprovado: ${DOC_CHECKLIST_ITEMS.find(d=>d.id===val).label}`);
            } else { 
                lead.docs = lead.docs.filter(d => d !== val); 
                lead.timeline.unshift(`[${getTime()}] Documento desmarcado: ${DOC_CHECKLIST_ITEMS.find(d=>d.id===val).label}`);
            }
            
            const label = checkboxEl.closest('label');
            const icon = label.querySelector('i');
            if(checkboxEl.checked) {
                label.className = `cursor-pointer flex items-center justify-between p-3 rounded-lg border transition-all chk-approved`;
                icon.className = `fa-solid fa-check-circle text-lg`;
            } else {
                label.className = `cursor-pointer flex items-center justify-between p-3 rounded-lg border transition-all chk-pending`;
                icon.className = `fa-solid fa-clock text-lg`;
            }
            saveLeadsDB(); 
            triggerAutoSaveUI('save-ind-lead');
            updateProgressBar(lead);
            renderTimeline(lead);
        }

        window.handleFileDrop = function(event) {
            event.preventDefault();
            event.currentTarget.classList.remove('border-primary');
            const files = event.dataTransfer.files;
            if(files.length) {
                const dt = new DataTransfer();
                Array.from(files).forEach(f => dt.items.add(f));
                document.getElementById('file-upload-lead').files = dt.files;
                handleLeadFileUpload({ target: { files: dt.files, value: '' } });
            }
        }

        window.handleLeadFileUpload = async function(event) {
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value); 
            if(!lead) return;
            const files = event.target.files; 
            if(!files.length) return;
            if(!lead.files) lead.files = [];

            const uploadPromises = Array.from(files).map(async file => {
                const ehPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
                if(!ehPdf) {
                    showToast(`${file.name}: somente arquivos PDF são aceitos.`, 'error');
                    return;
                }
                if(file.size > 5 * 1024 * 1024) {
                    showToast(`${file.name}: tamanho máximo é 5 MB.`, 'error');
                    return;
                }
                try {
                    showToast(`Enviando ${file.name}...`, 'info');
                    // Nome seguro para o Storage: tira acentos, espaços e caracteres especiais
                    const nomeSeguro = file.name
                        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // remove acentos
                        .replace(/[^a-zA-Z0-9._-]/g, '_');                  // troca o resto por _
                    const filePath = `leads/${lead.id}/${generateId()}_${nomeSeguro}`;
                    const { data, error } = await _sb.storage.from('crm-files').upload(filePath, file, { upsert: false });
                    if(error) throw error;
                    const { data: urlData } = _sb.storage.from('crm-files').getPublicUrl(filePath);
                    lead.files.push({
                        id: generateId(), name: file.name, type: file.type,
                        url: urlData.publicUrl, path: filePath,
                        date: getDateStr(), user: currentUser.name
                    });
                    lead.timeline.unshift(`[${getTime()}] Arquivo anexado: ${file.name} por ${currentUser.name}`);
                    await saveLeadsDB();
                    renderFiles(lead);
                    renderTimeline(lead);
                    updateProgressBar(lead);
                    showToast(`Arquivo ${file.name} salvo!`, 'success');
                } catch(err) {
                    showToast(`Erro ao enviar ${file.name}: ${err.message}`, 'error');
                }
            });
            await Promise.all(uploadPromises);
            event.target.value = '';
        }

        function renderFiles(lead) {
            const container = document.getElementById('lead-file-list');
            const emptyState = document.getElementById('lead-file-empty');
            container.innerHTML = '';
            if(!lead.files || lead.files.length === 0) {
                container.classList.add('hidden'); 
                emptyState.classList.remove('hidden'); 
                return;
            }
            container.classList.remove('hidden'); 
            emptyState.classList.add('hidden');

            lead.files.forEach(file => {
                const isPdf = file.type.includes('pdf');
                const isImg = file.type.includes('image');
                const icon = isPdf ? 'fa-file-pdf text-red-400' : (isImg ? 'fa-image text-blue-400' : 'fa-file text-slate-400');
                
                const src = file.url || file.data || '';
                const preview = isImg ? `<img src="${src}" class="w-full h-32 object-cover rounded-lg mb-3" alt="${file.name}">` : '';

                container.insertAdjacentHTML('beforeend', `
                    <div class="bg-slate-800/80 border border-slate-700 p-4 rounded-xl flex flex-col justify-between group hover:border-slate-500 transition-colors shadow-sm">
                        ${preview}
                        <div class="flex items-start gap-3 mb-4">
                            <div class="p-3 bg-slate-900 rounded-lg shrink-0"><i class="fa-solid ${icon} text-2xl"></i></div>
                            <div class="overflow-hidden">
                                <h5 class="text-sm font-bold text-white truncate" title="${file.name}">${file.name}</h5>
                                <p class="text-[10px] text-slate-400 mt-1 uppercase tracking-wider">${file.date} • ${file.user}</p>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <a href="${src}" target="_blank" rel="noopener" class="flex-1 bg-primary/20 hover:bg-primary text-primary hover:text-white text-xs font-bold py-2 rounded transition-colors text-center"><i class="fa-solid fa-eye"></i> Visualizar</a>
                            <a href="${src}" download="${file.name}" class="flex-1 bg-slate-700 hover:bg-slate-600 hover:text-white text-slate-300 text-xs font-bold py-2 rounded transition-colors text-center"><i class="fa-solid fa-download"></i> Baixar</a>
                            <button onclick="deleteFile('${file.id}')" class="px-3 bg-slate-700 hover:bg-red-500/20 hover:text-red-400 text-slate-300 text-xs font-bold rounded transition-colors"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                `);
            });
        }

        window.deleteFile = async function(fileId) {
            if(!confirm('Excluir este documento permanentemente?')) return;
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value);
            if(!lead) return;
            const file = lead.files.find(f => f.id === fileId);
            if(!file) return;
            if(file.path) {
                await _sb.storage.from('crm-files').remove([file.path]);
            }
            lead.files = lead.files.filter(f => f.id !== fileId);
            lead.timeline.unshift(`[${getTime()}] Arquivo excluído: ${file.name} por ${currentUser.name}`);
            await saveLeadsDB();
            renderFiles(lead);
            renderTimeline(lead);
            updateProgressBar(lead);
            showToast('Documento excluído.', 'info');
        }

        window.deleteLead = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            if(!confirm(`Excluir o lead "${lead.name}" permanentemente?`)) return;
            
            DB.leads = DB.leads.filter(l => l.id !== id);
            saveLeadsDB();
            closeModal('modal-lead-details');
            showToast('Lead excluído.', 'info');
            addNotification(`Lead "${lead.name}" foi excluído`, 'warning');
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
        }

        window.renderTimeline = function(lead) {
            const container = document.getElementById('ld-timeline');
            container.innerHTML = `<div class="absolute left-[27px] top-4 bottom-2 w-px bg-slate-700/60"></div>`;
            document.getElementById('timeline-counter').textContent = (lead.timeline || []).length;

            (lead.timeline || []).forEach(item => {
                const match = item.match(/\[(.*?)\] (.*)/);
                const time = match ? match[1] : '';
                const text = match ? match[2] : item;
                container.insertAdjacentHTML('beforeend', `
                <div class="relative pl-10">
                    <div class="absolute left-[21px] top-2 w-2.5 h-2.5 bg-primary rounded-full border-2 border-slate-900 shadow-[0_0_6px_rgba(59,130,246,0.5)] z-10"></div>
                    <div class="bg-slate-800/40 px-3 py-2 rounded-lg border border-slate-700/40 hover:bg-slate-800/70 transition-colors">
                        <span class="text-[10px] font-bold text-blue-400/80 block mb-0.5 tracking-wide">${time}</span>
                        <span class="text-xs text-slate-300">${text}</span>
                    </div>
                </div>`);
            });
        }

        window.addObservation = function() {
            // Função desativada — a timeline agora é exclusivamente automática.
            // Para conversar com a equipe, use a aba "Mensagens".
            showToast('Use a aba "Mensagens" para registrar observações e conversas.', 'info');
        }

        window.openWhatsApp = function() {
            const lead = DB.leads.find(l => l.id === document.getElementById('ld-id').value);
            if(!lead || !lead.phone) { showToast('Telefone não cadastrado', 'warning'); return; }
            const phone = lead.phone.replace(/\D/g,'');
            const msg = encodeURIComponent(`Olá ${lead.name}, tudo bem? Aqui é ${currentUser.name} da Audaz.`);
            window.open(`https://wa.me/55${phone}?text=${msg}`, '_blank');
            lead.timeline.unshift(`[${getTime()}] Contato WhatsApp iniciado por ${currentUser.name}`);
            saveLeadsDB();
            renderTimeline(lead);
        }

        window.openModal = function(id) {
            const modal = document.getElementById(id);
            const content = document.getElementById(id + '-content');
            if(!modal) return;
            modal.classList.remove('hidden');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                if(content) content.classList.remove('scale-95');
            }, 10);
        }

        window.closeModal = function(id) {
            const modal = document.getElementById(id); 
            const content = document.getElementById(id + '-content');
            modal.classList.add('opacity-0'); 
            if(content) content.classList.add('scale-95');
            setTimeout(() => modal.classList.add('hidden'), 300);
        }

        // ====================================================================
        // 14. EXPORTAÇÃO / IMPORTAÇÃO
        // ====================================================================
        window.handleSysLogoUpload = async function(event) {
            const file = event.target.files[0];
            if(!file) return;
            if(file.size > 2 * 1024 * 1024) { showToast('Imagem muito grande (máx 2MB)', 'error'); return; }
            if(file.type !== 'image/png') { showToast('Apenas arquivos PNG são permitidos.', 'error'); return; }
            try {
                showToast('Enviando imagem...', 'info');
                const { error } = await _sb.storage.from('crm-files').upload('system/logo.png', file, { upsert: true });
                if(error) throw error;
                const { data } = _sb.storage.from('crm-files').getPublicUrl('system/logo.png');
                localStorage.setItem('audaz_sys_logo', data.publicUrl + '?t=' + Date.now());
                loadSysLogo();
                showToast('Imagem carregada com sucesso!', 'success');
            } catch(err) {
                showToast('Erro ao enviar imagem: ' + err.message, 'error');
            }
            event.target.value = '';
        }

        window.removeSysLogo = async function() {
            if(!confirm('Remover a imagem do sistema?')) return;
            await _sb.storage.from('crm-files').remove(['system/logo.png']);
            localStorage.removeItem('audaz_sys_logo');
            loadSysLogo();
            showToast('Imagem removida.', 'info');
        }

        // Gera um favicon recortando as bordas transparentes (logo preenche o ícone)
        function gerarFaviconRecortado(url) {
            const im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = function() {
                try {
                    const w = im.naturalWidth, h = im.naturalHeight;
                    if(!w || !h) return;
                    const c = document.createElement('canvas'); c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(im, 0, 0);
                    const data = ctx.getImageData(0, 0, w, h).data; // pode lançar se CORS bloquear
                    let minX = w, minY = h, maxX = 0, maxY = 0, achou = false;
                    for(let y = 0; y < h; y++) for(let x = 0; x < w; x++) {
                        if(data[(y*w + x)*4 + 3] > 12) { achou = true;
                            if(x < minX) minX = x; if(x > maxX) maxX = x;
                            if(y < minY) minY = y; if(y > maxY) maxY = y;
                        }
                    }
                    if(!achou) { minX = 0; minY = 0; maxX = w-1; maxY = h-1; }
                    const cw = maxX - minX + 1, ch = maxY - minY + 1;
                    const size = 64, margem = 2;
                    const out = document.createElement('canvas'); out.width = size; out.height = size;
                    const octx = out.getContext('2d');
                    const escala = Math.min((size - margem*2)/cw, (size - margem*2)/ch);
                    const dw = cw*escala, dh = ch*escala;
                    octx.drawImage(c, minX, minY, cw, ch, (size-dw)/2, (size-dh)/2, dw, dh);
                    const fav = document.getElementById('favicon');
                    if(fav) fav.href = out.toDataURL('image/png');
                } catch(e) { /* CORS ou outro — mantém o favicon padrão */ }
            };
            im.src = url;
        }

        function loadSysLogo() {
            const { data } = _sb.storage.from('crm-files').getPublicUrl('system/logo.png');
            const url = data.publicUrl + '?t=' + Date.now();

            const tester = new Image();
            tester.onload = function() {
                const imgTag = `<img src="${url}" alt="CRM AUDAZ" class="max-h-20 w-auto object-contain drop-shadow-[0_0_25px_rgba(59,130,246,0.5)]">`;
                const sidebarC = document.getElementById('logo-sidebar-container');
                const loginC = document.getElementById('logo-login-container');
                if(sidebarC) sidebarC.innerHTML = imgTag;
                if(loginC) loginC.innerHTML = imgTag.replace('max-h-20','h-20 mx-auto');

                const img = document.getElementById('logo-preview-img');
                const empty = document.getElementById('logo-preview-empty');
                if(img) { img.src = url; img.classList.remove('hidden'); }
                if(empty) empty.classList.add('hidden');

                // Atualiza o ícone da aba (favicon) com a logo, recortando o espaço vazio
                const fav = document.getElementById('favicon');
                if(fav) fav.href = url;
                gerarFaviconRecortado(url);
            };
            tester.onerror = function() {
                const img = document.getElementById('logo-preview-img');
                const empty = document.getElementById('logo-preview-empty');
                if(img) img.classList.add('hidden');
                if(empty) empty.classList.remove('hidden');
            };
            tester.src = url;
        }

        // ====================================================================
        // CONFIGURAÇÃO DE PIPELINES
        // ====================================================================
        let _currentPipelineTab = 'leads';

        const PIPELINE_COLORS = [
            { label: 'Cinza',    value: 'border-l-slate-400' },
            { label: 'Amarelo',  value: 'border-l-yellow-400' },
            { label: 'Laranja',  value: 'border-l-orange-500' },
            { label: 'Vermelho', value: 'border-l-red-500' },
            { label: 'Verde',    value: 'border-l-green-400' },
            { label: 'Verde Esc',value: 'border-l-emerald-400' },
            { label: 'Azul',     value: 'border-l-blue-400' },
            { label: 'Roxo',     value: 'border-l-purple-400' },
            { label: 'Teal',     value: 'border-l-teal-400' },
            { label: 'Índigo',   value: 'border-l-indigo-400' },
            { label: 'Rosa',     value: 'border-l-pink-400' },
        ];

        window.switchPipelineTab = function(tab) {
            _capturePipelineInputs(); // salva edições da aba atual antes de trocar
            _currentPipelineTab = tab;
            document.querySelectorAll('.pipeline-tab-btn').forEach(b => {
                b.className = 'pipeline-tab-btn px-4 py-2 rounded-lg text-sm font-bold text-slate-400 hover:bg-slate-700 transition-colors';
            });
            const active = document.getElementById('ptab-' + tab);
            if(active) active.className = 'pipeline-tab-btn px-4 py-2 rounded-lg text-sm font-bold bg-primary/20 text-blue-400 border border-primary/30';
            renderPipelineEditor(tab);
        }

        // Lê o que está nos campos de volta para o array (evita perder edições não salvas)
        function _capturePipelineInputs() {
            const stages = PIPELINES[_currentPipelineTab];
            if(!stages) return;
            document.querySelectorAll('.pipeline-stage-input').forEach((input, i) => {
                if(stages[i]) stages[i].title = input.value.trim() || stages[i].title;
            });
            document.querySelectorAll('.pipeline-stage-color').forEach((sel, i) => {
                if(stages[i]) stages[i].color = sel.value;
            });
        }
        function _escAttr(s) { return String(s == null ? '' : s).split('"').join('&quot;'); }

        function renderPipelineEditor(tab) {
            const stages = PIPELINES[tab];
            const container = document.getElementById('pipeline-editor-container');
            if(!container) return;

            container.innerHTML = `
                <p class="text-[11px] text-slate-500 mb-3"><i class="fa-solid fa-arrows-up-down mr-1"></i> Arraste pelo ícone <i class="fa-solid fa-grip-vertical mx-0.5"></i> para reordenar as etapas.</p>
                <div class="space-y-3" id="pipeline-stages-list">
                    ${stages.map((s, i) => `
                    <div class="flex items-center gap-3 bg-slate-800/60 border border-slate-700/50 rounded-xl px-4 py-3" data-index="${i}">
                        <i class="fa-solid fa-grip-vertical pipeline-drag-handle text-slate-500 hover:text-white text-sm" style="cursor:grab" title="Arraste para reordenar"></i>
                        <div class="w-3 h-3 rounded-full flex-shrink-0 ${s.color.replace('border-l-','bg-')}"></div>
                        <input type="text" value="${_escAttr(s.title)}" data-index="${i}" data-field="title"
                            class="pipeline-stage-input flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary"
                            placeholder="Nome da etapa">
                        <select data-index="${i}" data-field="color" onchange="_capturePipelineInputs(); renderPipelineEditor(_currentPipelineTab)"
                            class="pipeline-stage-color bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary">
                            ${PIPELINE_COLORS.map(c => `<option value="${c.value}" ${s.color === c.value ? 'selected' : ''}>${c.label}</option>`).join('')}
                        </select>
                        <button onclick="removePipelineStage(${i})" class="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-2 rounded-lg transition-colors flex-shrink-0" title="Remover etapa">
                            <i class="fa-solid fa-trash text-sm"></i>
                        </button>
                    </div>`).join('')}
                </div>`;

            // Ativa arrastar-e-soltar para reordenar as etapas
            const listEl = document.getElementById('pipeline-stages-list');
            if(listEl && window.Sortable) {
                Sortable.create(listEl, {
                    handle: '.pipeline-drag-handle',
                    animation: 150,
                    ghostClass: 'sortable-ghost',
                    onEnd: function(evt) {
                        if(evt.oldIndex === evt.newIndex) return;
                        const tab = _currentPipelineTab;
                        const orig = PIPELINES[tab];
                        // Reconstrói a lista lendo a NOVA ordem direto das linhas na tela,
                        // preservando o id de cada etapa (evita embaralhar nomes)
                        const novos = [];
                        Array.from(listEl.children).forEach(row => {
                            const input = row.querySelector('.pipeline-stage-input');
                            const sel = row.querySelector('.pipeline-stage-color');
                            if(!input) return;
                            const oi = parseInt(input.getAttribute('data-index'), 10);
                            const base = orig[oi];
                            if(!base) return;
                            novos.push({ id: base.id, title: (input.value.trim() || base.title), color: (sel ? sel.value : base.color) });
                        });
                        if(novos.length === orig.length) {
                            PIPELINES[tab] = novos;
                            renderPipelineEditor(tab);
                            showToast('Ordem alterada — clique em "Salvar Alterações" para confirmar.', 'info');
                        }
                    }
                });
            }
        }

        window.addPipelineStage = function() {
            _capturePipelineInputs(); // preserva o que já foi digitado
            const stages = PIPELINES[_currentPipelineTab];
            const newId = 'etapa-' + Date.now();
            stages.push({ id: newId, title: 'Nova Etapa', color: 'border-l-slate-400' });
            renderPipelineEditor(_currentPipelineTab);
            // Foca no novo input
            const inputs = document.querySelectorAll('.pipeline-stage-input');
            if(inputs.length) { const last = inputs[inputs.length-1]; last.focus(); last.select(); }
        }

        window.removePipelineStage = function(index) {
            _capturePipelineInputs(); // preserva edições antes de remover
            const stages = PIPELINES[_currentPipelineTab];
            if(stages.length <= 1) { showToast('O pipeline precisa ter pelo menos 1 etapa.', 'error'); return; }
            const stage = stages[index];
            const leadsInStage = DB.leads.filter(l => l.pipeline === _currentPipelineTab && l.stageId === stage.id).length;
            if(leadsInStage > 0) {
                if(!confirm(`A etapa "${stage.title}" tem ${leadsInStage} lead(s). Ao remover, eles irão para a primeira etapa. Continuar?`)) return;
                const firstStageId = stages[0].id === stage.id ? stages[1].id : stages[0].id;
                DB.leads.forEach(l => { if(l.pipeline === _currentPipelineTab && l.stageId === stage.id) l.stageId = firstStageId; });
                saveLeadsDB();
            }
            stages.splice(index, 1);
            renderPipelineEditor(_currentPipelineTab);
        }

        window.savePipelineChanges = async function() {
            // Lê os valores atuais dos inputs
            const inputs = document.querySelectorAll('.pipeline-stage-input');
            const colors = document.querySelectorAll('.pipeline-stage-color');
            const stages = PIPELINES[_currentPipelineTab];
            inputs.forEach((input, i) => {
                if(stages[i]) stages[i].title = input.value.trim() || stages[i].title;
            });
            colors.forEach((sel, i) => {
                if(stages[i]) stages[i].color = sel.value;
            });
            await savePipelinesDB();
            triggerAutoSaveUI();
            showToast('Pipeline salvo com sucesso!', 'success');
            // Atualiza o kanban se estiver visível
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            renderPipelineEditor(_currentPipelineTab);
        }

        window.resetPipelineToDefault = async function() {
            if(!confirm(`Restaurar o pipeline "${_currentPipelineTab}" para o padrão? Isso desfará todas as suas alterações.`)) return;
            PIPELINES[_currentPipelineTab] = JSON.parse(JSON.stringify(PIPELINES_DEFAULT[_currentPipelineTab]));
            await savePipelinesDB();
            renderPipelineEditor(_currentPipelineTab);
            showToast('Pipeline restaurado para o padrão!', 'info');
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
        }

        // ====================================================================
        // LISTAS DE SELEÇÃO (Construtoras / Empreendimentos) — gerenciadas pelo Diretor
        // ====================================================================
        function renderListasEditor() {
            const render = (tipo, containerId, cor) => {
                const cont = document.getElementById(containerId);
                if(!cont) return;
                const items = LISTAS[tipo] || [];
                if(items.length === 0) {
                    cont.innerHTML = '<p class="text-xs text-slate-500 italic py-2">Nenhum item cadastrado ainda.</p>';
                    return;
                }
                cont.innerHTML = items.map((it, i) => `
                    <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2">
                        <span class="text-sm text-white">${it}</span>
                        <button onclick="removeItemLista('${tipo}', ${i})" class="text-red-400 hover:text-red-300 hover:bg-red-500/10 p-1.5 rounded transition-colors"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>`).join('');
            };
            render('construtoras', 'lista-construtoras');
            render('empreendimentos', 'lista-empreendimentos');
        }

        window.addItemLista = async function(tipo) {
            const inputId = tipo === 'construtoras' ? 'nova-construtora' : 'novo-empreendimento';
            const input = document.getElementById(inputId);
            const val = input.value.trim();
            if(!val) return;
            if(!LISTAS[tipo]) LISTAS[tipo] = [];
            if(LISTAS[tipo].some(x => x.toLowerCase() === val.toLowerCase())) {
                showToast('Esse item já existe na lista.', 'warning'); return;
            }
            LISTAS[tipo].push(val);
            LISTAS[tipo].sort((a,b) => a.localeCompare(b));
            await saveListasDB();
            input.value = '';
            renderListasEditor();
            triggerAutoSaveUI();
            showToast('Item adicionado!', 'success');
        }

        window.removeItemLista = async function(tipo, index) {
            const item = LISTAS[tipo][index];
            if(!confirm(`Remover "${item}" da lista?`)) return;
            LISTAS[tipo].splice(index, 1);
            await saveListasDB();
            renderListasEditor();
            showToast('Item removido.', 'info');
        }

        window.exportBackupJSON = function() {
            const backup = { users: DB.users, leads: DB.leads, exportDate: new Date().toISOString() };
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; 
            a.download = `audaz_backup_${getDateStr().replace(/\//g,'-')}.json`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('Backup exportado!', 'success');
        }

        window.importBackupJSON = function(event) {
            const file = event.target.files[0]; if(!file) return;
            if(!confirm('Restaurar o backup substituirá todos os dados atuais. Continuar?')) return;
            
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    if(data.users && data.leads) {
                        DB.users = data.users;
                        DB.leads = data.leads;
                        saveUsersDB();
                        saveLeadsDB();
                        showToast('Backup restaurado com sucesso!', 'success');
                        setTimeout(() => location.reload(), 1000);
                    } else throw new Error('Formato inválido');
                } catch(err) { showToast('Arquivo de backup inválido', 'error'); }
            };
            reader.readAsText(file);
            event.target.value = '';
        }

        window.exportLeadsCSV = function() {
            const leads = getVisibleLeads();
            if(leads.length === 0) { showToast('Nenhum lead para exportar', 'warning'); return; }
            
            const headers = ['Nome','Telefone','E-mail','CPF','Cidade','Origem','Renda','FGTS','Score','Corretor','Pipeline','Etapa','Temperatura','Data'];
            const rows = leads.map(l => [
                l.name || '', l.phone || '', l.email || '', l.cpf || '', l.city || '',
                l.origin || '', l.income || '', l.fgts || '', l.score || '',
                l.broker || '', 
                {leads:'Leads', analise:'Análise', financeiro:'Financeiro'}[l.pipeline] || '',
                PIPELINES[l.pipeline]?.find(s => s.id === l.stageId)?.title || '',
                l.temp || '', l.date || ''
            ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
            
            const csv = '\uFEFF' + [headers.join(','), ...rows].join('\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; 
            a.download = `audaz_leads_${getDateStr().replace(/\//g,'-')}.csv`;
            a.click();
            URL.revokeObjectURL(url);
            showToast(`${leads.length} leads exportados!`, 'success');
        }

        // ====================================================================
        // GESTÃO DE USUÁRIOS & ACESSOS
        // ====================================================================
        
        // Matriz de permissões hierárquica
        // Define quais cargos cada role pode criar/editar
        const ROLE_PERMISSIONS = {
            'Diretor': {
                canCreate: ['Diretor', 'Administrativo', 'Gerente', 'Corretor'],
                canEdit:   ['Diretor', 'Administrativo', 'Gerente', 'Corretor'],
                canDelete: ['Administrativo', 'Gerente', 'Corretor'], // não pode se autoremover via lista; tratado
                description: 'Acesso total. Cria e gerencia qualquer usuário.'
            },
            'Administrativo': {
                canCreate: ['Corretor'],
                canEdit:   ['Corretor', 'Administrativo'], // pode editar a si mesmo
                canDelete: ['Corretor'],
                description: 'Cria e gerencia corretores. Não acessa configurações estratégicas.'
            },
            'Gerente': {
                canCreate: ['Corretor'],
                canEdit:   ['Corretor', 'Gerente'], // pode editar a si mesmo
                canDelete: ['Corretor'],
                description: 'Cria e vincula corretores à equipe. Sem acesso a financeiro estratégico.'
            },
            'Corretor': {
                canCreate: [],
                canEdit:   ['Corretor'], // só si mesmo
                canDelete: [],
                description: 'Acesso operacional apenas aos próprios leads e pipeline.'
            }
        };

        window.canManageUsers = function() {
            if(!currentUser) return false;
            const perm = ROLE_PERMISSIONS[currentUser.role];
            return perm && perm.canCreate.length > 0;
        }

        window.getCreatableRoles = function() {
            if(!currentUser) return [];
            return ROLE_PERMISSIONS[currentUser.role]?.canCreate || [];
        }

        window.canEditUser = function(targetUser) {
            if(!currentUser || !targetUser) return false;
            // Usuário pode sempre editar a si mesmo
            if(targetUser.id === currentUser.id) return true;
            const perm = ROLE_PERMISSIONS[currentUser.role];
            return perm && perm.canEdit.includes(targetUser.role);
        }

        window.canDeleteUser = function(targetUser) {
            if(!currentUser || !targetUser) return false;
            // Nunca permitir auto-exclusão
            if(targetUser.id === currentUser.id) return false;
            const perm = ROLE_PERMISSIONS[currentUser.role];
            return perm && perm.canDelete.includes(targetUser.role);
        }

        function getRoleBadge(role) {
            const styles = {
                'Diretor': 'bg-amber-500/20 text-amber-300 border-amber-500/40',
                'Administrativo': 'bg-slate-500/20 text-slate-300 border-slate-500/40',
                'Gerente': 'bg-blue-500/20 text-blue-300 border-blue-500/40',
                'Corretor': 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            };
            const icons = {
                'Diretor': 'fa-crown',
                'Administrativo': 'fa-briefcase',
                'Gerente': 'fa-user-tie',
                'Corretor': 'fa-handshake'
            };
            return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold border ${styles[role] || 'bg-slate-700 text-slate-300'}"><i class="fa-solid ${icons[role] || 'fa-user'}"></i> ${role}</span>`;
        }

        function getStatusBadge(status) {
            if(status === 'Ativo') return '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"><span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span> Ativo</span>';
            return '<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-700 text-slate-400 border border-slate-600"><span class="w-1.5 h-1.5 bg-slate-500 rounded-full"></span> Inativo</span>';
        }

        function getInitialsAvatar(name, photo, size = 'w-10 h-10 text-sm') {
            if(photo) return `<img src="${photo}" class="${size} rounded-full object-cover shadow border border-slate-700" alt="">`;
            const initials = (name || '?').substring(0, 2).toUpperCase();
            return `<div class="${size} rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white font-bold shadow border border-slate-700">${initials}</div>`;
        }

        function timeAgo(dateStr) {
            if(!dateStr) return '<span class="text-slate-500">Nunca acessou</span>';
            try {
                const d = new Date(dateStr);
                const diff = (Date.now() - d.getTime()) / 1000;
                if(diff < 60) return 'Agora mesmo';
                if(diff < 3600) return `${Math.floor(diff/60)} min atrás`;
                if(diff < 86400) return `${Math.floor(diff/3600)}h atrás`;
                if(diff < 604800) return `${Math.floor(diff/86400)}d atrás`;
                return d.toLocaleDateString('pt-BR');
            } catch(e) { return dateStr; }
        }

        window.renderUsersTable = function() {
            if(!canManageUsers()) return;
            const tbody = document.getElementById('users-tbody');
            const searchTerm = (document.getElementById('users-search')?.value || '').toLowerCase().trim();
            const filterRole = document.getElementById('users-filter-role')?.value || '';
            const filterStatus = document.getElementById('users-filter-status')?.value || '';

            // Stats por cargo (sempre mostra TODOS, não filtrados)
            document.getElementById('stat-diretores').textContent = DB.users.filter(u => u.role === 'Diretor').length;
            document.getElementById('stat-gerentes').textContent = DB.users.filter(u => u.role === 'Gerente').length;
            document.getElementById('stat-corretores').textContent = DB.users.filter(u => u.role === 'Corretor' && u.status === 'Ativo').length;
            document.getElementById('stat-admins').textContent = DB.users.filter(u => u.role === 'Administrativo').length;
            
            const counterUsers = document.getElementById('counter-users');
            if(counterUsers) counterUsers.textContent = DB.users.length;

            let filtered = [...DB.users];
            if(searchTerm) {
                filtered = filtered.filter(u => 
                    (u.name||'').toLowerCase().includes(searchTerm) ||
                    (u.email||'').toLowerCase().includes(searchTerm) ||
                    (u.phone||'').toLowerCase().includes(searchTerm) ||
                    (u.team||'').toLowerCase().includes(searchTerm)
                );
            }
            if(filterRole) filtered = filtered.filter(u => u.role === filterRole);
            if(filterStatus) filtered = filtered.filter(u => u.status === filterStatus);

            if(filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" class="py-16 text-center text-slate-500"><i class="fa-solid fa-users-slash text-4xl mb-3 block opacity-50"></i><p>Nenhum usuário encontrado com os filtros aplicados</p></td></tr>`;
                return;
            }

            // Ordenar: Diretor > Administrativo > Gerente > Corretor; depois por nome
            const order = { 'Diretor': 0, 'Administrativo': 1, 'Gerente': 2, 'Corretor': 3 };
            filtered.sort((a,b) => (order[a.role] - order[b.role]) || a.name.localeCompare(b.name));

            tbody.innerHTML = filtered.map(u => {
                const isMe = u.id === currentUser.id;
                const editable = canEditUser(u);
                const deletable = canDeleteUser(u);
                const myLeadsCount = DB.leads.filter(l => l.broker === u.name).length;

                return `
                <tr class="hover:bg-slate-800/40 transition-colors">
                    <td class="px-4 py-3">
                        <div class="flex items-center gap-3">
                            ${getInitialsAvatar(u.name, u.photo)}
                            <div class="min-w-0">
                                <div class="font-bold text-white flex items-center gap-2 truncate">${u.name}${isMe ? '<span class="text-[9px] bg-primary/30 text-blue-200 px-1.5 py-0.5 rounded uppercase font-bold">você</span>' : ''}</div>
                                <div class="text-xs text-slate-400 truncate">${u.email}</div>
                                ${u.phone ? `<div class="text-[11px] text-slate-500"><i class="fa-solid fa-phone text-[9px]"></i> ${u.phone}</div>` : ''}
                            </div>
                        </div>
                    </td>
                    <td class="px-4 py-3">${getRoleBadge(u.role)}</td>
                    <td class="px-4 py-3 hidden md:table-cell">
                        ${u.team ? `<span class="text-sm text-slate-300">${u.team}</span>` : '<span class="text-xs text-slate-600">—</span>'}
                        ${u.role === 'Corretor' ? `<div class="text-[11px] text-slate-500 mt-0.5"><i class="fa-solid fa-folder-open text-[9px]"></i> ${myLeadsCount} ${myLeadsCount === 1 ? 'lead' : 'leads'}</div>` : ''}
                    </td>
                    <td class="px-4 py-3 hidden lg:table-cell">
                        ${u.goal > 0 ? `<div class="text-xs"><span class="text-slate-500">Meta:</span> <span class="text-emerald-300 font-bold">${formatCurrency(u.goal)}</span></div>` : ''}
                        ${u.commission > 0 ? `<div class="text-xs"><span class="text-slate-500">Comissão:</span> <span class="text-blue-300 font-bold">${u.commission}%</span></div>` : ''}
                        ${(!u.goal && !u.commission) ? '<span class="text-xs text-slate-600">—</span>' : ''}
                    </td>
                    <td class="px-4 py-3 hidden lg:table-cell"><span class="text-xs text-slate-400">${timeAgo(u.lastAccess)}</span></td>
                    <td class="px-4 py-3">${getStatusBadge(u.status)}</td>
                    <td class="px-4 py-3">
                        <div class="flex items-center justify-end gap-1">
                            ${editable ? `<button onclick="openUserModal('${u.id}')" title="Editar usuário" class="px-3 py-2 rounded-lg hover:bg-blue-500/20 text-blue-300 transition-colors flex items-center gap-1 text-xs font-bold"><i class="fa-solid fa-pen-to-square"></i></button>` : ''}
                            ${editable && !isMe ? `<button onclick="toggleUserStatus('${u.id}')" title="${u.status === 'Ativo' ? 'Desativar' : 'Ativar'}" class="px-3 py-2 rounded-lg hover:bg-amber-500/20 text-amber-300 transition-colors"><i class="fa-solid ${u.status === 'Ativo' ? 'fa-toggle-on' : 'fa-toggle-off'}"></i></button>` : ''}
                            ${deletable ? `<button onclick="deleteUser('${u.id}')" title="Excluir" class="px-3 py-2 rounded-lg hover:bg-red-500/20 text-red-300 transition-colors"><i class="fa-solid fa-trash"></i></button>` : ''}
                            ${(!editable && !deletable) ? '<span class="text-xs text-slate-600 px-2">Sem ações</span>' : ''}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }

        window.openUserModal = function(userId) {
            if(!canManageUsers() && !userId) { showToast('Você não tem permissão para criar usuários.', 'error'); return; }
            
            const isEdit = !!userId;
            const user = isEdit ? DB.users.find(u => u.id === userId) : null;

            if(isEdit && !canEditUser(user)) { showToast('Você não tem permissão para editar este usuário.', 'error'); return; }

            // Setup form
            document.getElementById('form-user').reset();
            document.getElementById('uf-id').value = userId || '';
            document.getElementById('modal-user-title').textContent = isEdit ? 'Editar Usuário' : 'Cadastrar Novo Usuário';
            document.getElementById('modal-user-icon').className = isEdit ? 'fa-solid fa-user-pen text-purple-300' : 'fa-solid fa-user-plus text-purple-300';
            document.getElementById('uf-submit-label').textContent = isEdit ? 'Salvar Alterações' : 'Criar Usuário';
            document.getElementById('uf-pass-hint').textContent = isEdit ? '(deixe em branco para manter)' : '(mínimo 6 caracteres)';
            document.getElementById('uf-pass').required = !isEdit;
            document.getElementById('uf-pass-strength').style.width = '0%';

            // Popular select de cargos com base nas permissões do usuário atual
            const roleSelect = document.getElementById('uf-role');
            let creatable = getCreatableRoles();
            // Se for edição e o cargo atual do alvo não estiver nas criáveis, ainda mostrar
            if(isEdit && user && !creatable.includes(user.role)) creatable = [...creatable, user.role];
            // Se a pessoa está editando a si mesma, mantém seu próprio cargo
            if(isEdit && user && user.id === currentUser.id && !creatable.includes(user.role)) creatable.push(user.role);
            
            const labels = {
                'Diretor': '👑 Diretor (Acesso Total)',
                'Administrativo': '📋 Administrativo',
                'Gerente': '👔 Gerente',
                'Corretor': '🤝 Corretor'
            };
            roleSelect.innerHTML = creatable.map(r => `<option value="${r}">${labels[r] || r}</option>`).join('');
            // Se não tem cargo criável e não é edição, bloquear
            if(creatable.length === 0) { showToast('Seu cargo não permite criar usuários.', 'error'); return; }

            // Preencher dados se edição
            if(isEdit && user) {
                document.getElementById('uf-name').value = user.name || '';
                document.getElementById('uf-email').value = user.email || '';
                document.getElementById('uf-phone').value = user.phone || '';
                document.getElementById('uf-team').value = user.team || '';
                document.getElementById('uf-goal').value = user.goal || '';
                document.getElementById('uf-commission').value = user.commission || '';
                document.getElementById('uf-role').value = user.role;
                setUserStatusUI(user.status || 'Ativo');
                // Foto
                if(user.photo) {
                    document.getElementById('uf-img-preview').src = user.photo;
                    document.getElementById('uf-img-preview').classList.remove('hidden');
                    document.getElementById('uf-initials').classList.add('hidden');
                    document.getElementById('uf-remove-photo').classList.remove('hidden');
                } else {
                    document.getElementById('uf-img-preview').classList.add('hidden');
                    document.getElementById('uf-initials').classList.remove('hidden');
                    document.getElementById('uf-initials').textContent = (user.name || '??').substring(0,2).toUpperCase();
                    document.getElementById('uf-remove-photo').classList.add('hidden');
                }
            } else {
                document.getElementById('uf-initials').textContent = '??';
                document.getElementById('uf-img-preview').classList.add('hidden');
                document.getElementById('uf-initials').classList.remove('hidden');
                document.getElementById('uf-remove-photo').classList.add('hidden');
                setUserStatusUI('Ativo');
            }

            updateRolePermissionsHint();
            openModal('modal-user');
            // Reaplica máscaras nos inputs do modal
            if(typeof setupMasks === 'function') setupMasks();
            setTimeout(() => document.getElementById('uf-name').focus(), 100);
        }

        window.updateRolePermissionsHint = function() {
            const role = document.getElementById('uf-role').value;
            const hint = document.getElementById('uf-role-hint');
            const autoCreate = document.getElementById('uf-auto-create-notice');
            
            const desc = ROLE_PERMISSIONS[role]?.description || '';
            const perms = ROLE_PERMISSIONS[role]?.canCreate || [];
            
            hint.innerHTML = `<div class="flex items-start gap-3"><i class="fa-solid fa-circle-info text-primary mt-0.5"></i><div><div class="font-bold text-white mb-1">Permissões de ${role}</div><div class="text-slate-400">${desc}</div>${perms.length > 0 ? `<div class="mt-2 text-[11px] text-slate-500">Pode criar: <span class="text-slate-300">${perms.join(', ')}</span></div>` : ''}</div></div>`;
            
            if(role === 'Corretor') autoCreate.classList.remove('hidden');
            else autoCreate.classList.add('hidden');
        }

        function setUserStatusUI(status) {
            document.getElementById('uf-status').value = status;
            document.querySelectorAll('.uf-status-btn').forEach(btn => {
                const isActive = btn.dataset.status === status;
                if(btn.dataset.status === 'Ativo') {
                    if(isActive) btn.className = 'uf-status-btn flex-1 py-3 rounded-lg border-2 border-emerald-500 bg-emerald-500/20 text-emerald-300 font-bold text-sm transition-all';
                    else btn.className = 'uf-status-btn flex-1 py-3 rounded-lg border-2 border-slate-700 bg-slate-800 text-slate-400 font-bold text-sm transition-all hover:border-slate-600';
                } else {
                    if(isActive) btn.className = 'uf-status-btn flex-1 py-3 rounded-lg border-2 border-red-500 bg-red-500/20 text-red-300 font-bold text-sm transition-all';
                    else btn.className = 'uf-status-btn flex-1 py-3 rounded-lg border-2 border-slate-700 bg-slate-800 text-slate-400 font-bold text-sm transition-all hover:border-slate-600';
                }
            });
        }

        window.toggleUfPass = function() {
            const input = document.getElementById('uf-pass');
            const eye = document.getElementById('uf-pass-eye');
            if(input.type === 'password') { input.type = 'text'; eye.className = 'fa-solid fa-eye-slash text-sm'; }
            else { input.type = 'password'; eye.className = 'fa-solid fa-eye text-sm'; }
        }

        window.handleUserPhoto = function(event) {
            const file = event.target.files[0];
            if(!file) return;
            if(file.size > 1024*1024) { showToast('Foto muito grande. Máximo 1MB.', 'error'); return; }
            const reader = new FileReader();
            reader.onload = (e) => {
                document.getElementById('uf-img-preview').src = e.target.result;
                document.getElementById('uf-img-preview').classList.remove('hidden');
                document.getElementById('uf-initials').classList.add('hidden');
                document.getElementById('uf-remove-photo').classList.remove('hidden');
                document.getElementById('uf-img-preview').dataset.changed = '1';
            };
            reader.readAsDataURL(file);
        }

        window.removeUserPhoto = function() {
            document.getElementById('uf-img-preview').classList.add('hidden');
            document.getElementById('uf-img-preview').src = '';
            document.getElementById('uf-img-preview').dataset.changed = '1';
            document.getElementById('uf-initials').classList.remove('hidden');
            document.getElementById('uf-remove-photo').classList.add('hidden');
            document.getElementById('uf-photo-input').value = '';
        }

        window.handleUserSubmit = function(event) {
            event.preventDefault();
            const id = document.getElementById('uf-id').value;
            const isEdit = !!id;
            
            const name = document.getElementById('uf-name').value.trim();
            const email = document.getElementById('uf-email').value.trim().toLowerCase();
            const phone = document.getElementById('uf-phone').value.trim();
            const team = document.getElementById('uf-team').value.trim();
            const role = document.getElementById('uf-role').value;
            const status = document.getElementById('uf-status').value;
            const pass = document.getElementById('uf-pass').value;
            const goal = parseFloat(document.getElementById('uf-goal').value) || 0;
            const commission = parseFloat(document.getElementById('uf-commission').value) || 0;
            const photoChanged = document.getElementById('uf-img-preview').dataset.changed === '1';
            const photoSrc = document.getElementById('uf-img-preview').src;
            const photo = photoChanged ? (document.getElementById('uf-img-preview').classList.contains('hidden') ? null : photoSrc) : undefined;

            // Validações
            if(!name) { showToast('Nome obrigatório.', 'error'); return; }
            if(!email || !/.+@.+\..+/.test(email)) { showToast('E-mail inválido.', 'error'); return; }
            if(!isEdit && pass.length < 6) { showToast('Senha deve ter ao menos 6 caracteres.', 'error'); return; }
            if(isEdit && pass && pass.length < 6) { showToast('Senha deve ter ao menos 6 caracteres.', 'error'); return; }
            
            // Verificar e-mail duplicado
            const duplicate = DB.users.find(u => u.email.toLowerCase() === email && u.id !== id);
            if(duplicate) { showToast('Este e-mail já está em uso por outro usuário.', 'error'); return; }

            // Verificar permissão para criar/editar esse cargo
            const creatable = getCreatableRoles();
            if(!isEdit && !creatable.includes(role)) {
                showToast(`Você não tem permissão para criar usuários do cargo ${role}.`, 'error');
                return;
            }

            if(isEdit) {
                const idx = DB.users.findIndex(u => u.id === id);
                if(idx === -1) { showToast('Usuário não encontrado.', 'error'); return; }
                const target = DB.users[idx];
                if(!canEditUser(target)) { showToast('Sem permissão para editar este usuário.', 'error'); return; }
                
                // Se está mudando o cargo, precisa permissão sobre o novo cargo também
                if(target.role !== role) {
                    const editPerm = ROLE_PERMISSIONS[currentUser.role].canEdit;
                    if(!editPerm.includes(role) && target.id !== currentUser.id) {
                        showToast(`Você não pode atribuir o cargo ${role}.`, 'error');
                        return;
                    }
                }

                const oldName = target.name;
                target.name = name;
                target.email = email;
                target.phone = phone;
                target.team = team;
                target.role = role;
                target.status = status;
                target.goal = goal;
                target.commission = commission;
                if(pass) { target.pass = pass; sincronizarSenhaOficial(target.email, pass); }
                if(photo !== undefined) target.photo = photo;

                // Se renomeou, atualizar broker nos leads
                if(oldName !== name && target.role === 'Corretor') {
                    DB.leads.forEach(l => { if(l.broker === oldName) l.broker = name; });
                    saveLeadsDB();
                }

                // Se for o próprio usuário, atualiza sessão
                if(target.id === currentUser.id) {
                    currentUser = {...target};
                    localStorage.setItem(DB_KEYS.LOGGED_USER, JSON.stringify(currentUser));
                    setupUIForUser();
                }

                saveUsersDB();
                triggerAutoSaveUI();
                closeModal('modal-user');
                renderUsersTable();
                populateBrokerDropdowns();
                showToast(`Usuário "${name}" atualizado!`, 'success');
                addNotification(`Usuário ${name} foi atualizado`, 'info');
            } else {
                const newUser = {
                    id: 'u_' + generateId(),
                    name, email, phone, team, role, status,
                    pass: pass,
                    goal, commission,
                    photo: photo === undefined ? null : photo,
                    lastAccess: null,
                    createdAt: getDateStr(),
                    createdBy: currentUser.id
                };
                DB.users.push(newUser);
                saveUsersDB();
                if(pass) sincronizarSenhaOficial(email, pass); // cria o acesso oficial (login) do novo usuário
                triggerAutoSaveUI();
                closeModal('modal-user');
                renderUsersTable();
                populateBrokerDropdowns();

                // Criação automática para corretor
                if(role === 'Corretor') {
                    showToast(`Corretor "${name}" criado! Acesso, pipeline e dashboard configurados automaticamente.`, 'success');
                    addNotification(`Novo corretor cadastrado: ${name} (${team || 'sem equipe'})`, 'success');
                } else {
                    showToast(`Usuário "${name}" criado com sucesso!`, 'success');
                    addNotification(`Novo ${role.toLowerCase()} cadastrado: ${name}`, 'success');
                }
            }
        }

        // Cancela todos os leads de um corretor, EXCETO os que estão em Ganhos (financeiro)
        function cancelarLeadsDoCorretor(nome, motivo) {
            const t = getTime();
            const now = new Date().toISOString();
            let count = 0;
            DB.leads.forEach(l => {
                if(l.broker !== nome) return;
                if(l.pipeline === 'financeiro') return;   // mantém os Ganhos intactos
                if(l.pipeline === 'cancelados') return;    // já cancelado
                l.previousPipeline = l.pipeline;
                l.previousStage = l.stageId;
                l.pipeline = 'cancelados';
                l.stageId = 'cancelado';
                l.cancelReason = motivo;
                l.canceledAt = now;
                l.canceledBy = currentUser.name;
                l.updatedAt = now;
                l.updatedBy = currentUser.name;
                l.timeline = l.timeline || [];
                l.timeline.unshift(`[${t}] Lead cancelado automaticamente — ${motivo}`);
                sincronizarPlanilha(l); // reflete na planilha, se já estava lá
                count++;
            });
            if(count) saveLeadsDB();
            return count;
        }

        window.toggleUserStatus = function(userId) {
            const user = DB.users.find(u => u.id === userId);
            if(!user) return;
            if(!canEditUser(user)) { showToast('Sem permissão.', 'error'); return; }
            if(user.id === currentUser.id) { showToast('Você não pode alterar seu próprio status.', 'error'); return; }

            const vaiDesativar = user.status === 'Ativo';
            if(vaiDesativar) {
                const qtd = DB.leads.filter(l => l.broker === user.name && l.pipeline !== 'financeiro' && l.pipeline !== 'cancelados').length;
                if(qtd > 0 && !confirm(`Desativar ${user.name}?\n\n${qtd} lead(s) dele(a) irão para Cancelados (os que estão em Ganhos são mantidos).`)) return;
            }

            user.status = vaiDesativar ? 'Inativo' : 'Ativo';
            saveUsersDB();
            let canceladosMsg = '';
            if(vaiDesativar) {
                const n = cancelarLeadsDoCorretor(user.name, `corretor ${user.name} desativado`);
                if(n) canceladosMsg = ` ${n} lead(s) movidos para Cancelados.`;
            }
            triggerAutoSaveUI();
            renderUsersTable();
            if(['leads','analise','financeiro','cancelados'].includes(currentView)) renderKanban(currentPipeline);
            showToast(`${user.name} agora está ${user.status}.${canceladosMsg}`, 'info');
            addNotification(`${user.name} ${user.status === 'Ativo' ? 'ativado' : 'desativado'}${canceladosMsg}`, user.status === 'Ativo' ? 'success' : 'warning');
        }

        window.deleteUser = function(userId) {
            const user = DB.users.find(u => u.id === userId);
            if(!user) return;
            if(!canDeleteUser(user)) { showToast('Sem permissão para excluir este usuário.', 'error'); return; }
            
            const aCancelar = DB.leads.filter(l => l.broker === user.name && l.pipeline !== 'financeiro' && l.pipeline !== 'cancelados').length;
            const emGanhos = DB.leads.filter(l => l.broker === user.name && l.pipeline === 'financeiro').length;
            const confirmMsg = `Excluir ${user.name}?\n\n${aCancelar} lead(s) irão para Cancelados.` +
                (emGanhos > 0 ? `\n${emGanhos} lead(s) em Ganhos serão mantidos.` : '');
            if(!confirm(confirmMsg)) return;

            // Cancela os leads do corretor (exceto Ganhos) antes de remover o usuário
            const n = cancelarLeadsDoCorretor(user.name, `corretor ${user.name} excluído`);

            DB.users = DB.users.filter(u => u.id !== userId);
            saveUsersDB();
            triggerAutoSaveUI();
            renderUsersTable();
            populateBrokerDropdowns();
            if(['leads','analise','financeiro','cancelados'].includes(currentView)) renderKanban(currentPipeline);
            showToast(`Usuário ${user.name} excluído.${n ? ' ' + n + ' lead(s) movidos para Cancelados.' : ''}`, 'info');
            addNotification(`Usuário ${user.name} foi removido. ${n} lead(s) cancelados (Ganhos mantidos).`, 'warning');
        }

        // Event listeners para os botões de status (delegação)
        document.addEventListener('click', function(e) {
            const btn = e.target.closest('.uf-status-btn');
            if(btn) {
                e.preventDefault();
                setUserStatusUI(btn.dataset.status);
            }
        });

        // Medidor de força para senha no modal de usuário
        document.addEventListener('input', function(e) {
            if(e.target.id === 'uf-pass') {
                const val = e.target.value;
                const bar = document.getElementById('uf-pass-strength');
                if(!bar) return;
                let strength = 0;
                if(val.length >= 6) strength += 25;
                if(val.length >= 10) strength += 25;
                if(/[A-Z]/.test(val)) strength += 25;
                if(/[0-9]/.test(val) || /[^A-Za-z0-9]/.test(val)) strength += 25;
                bar.style.width = strength + '%';
                bar.className = 'h-full transition-all duration-300 ' + 
                    (strength <= 25 ? 'bg-red-500' : strength <= 50 ? 'bg-orange-500' : strength <= 75 ? 'bg-blue-500' : 'bg-emerald-500');
            }
        });

        // ====================================================================
        // MOVER CLIENTE ENTRE PIPELINES (manual, com botão)
        // ====================================================================
        let currentMoveTarget = null;

        window.openMoveClientModal = function() {
            const leadId = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead) return;

            // Mostrar posição atual
            const pipeNames = { leads: 'Pipeline de Leads', analise: 'Análise de Crédito', financeiro: 'Ganhos / Financeiro' };
            const stageName = PIPELINES[lead.pipeline]?.find(s => s.id === lead.stageId)?.title || lead.stageId;
            document.getElementById('mv-current-stage').textContent = `${pipeNames[lead.pipeline]} → ${stageName}`;

            // Mostrar/esconder botões baseado no pipeline atual
            const btnAnalise = document.getElementById('mv-btn-analise');
            const btnFinanceiro = document.getElementById('mv-btn-financeiro');
            const btnLeads = document.getElementById('mv-btn-leads');
            btnAnalise.style.display = lead.pipeline === 'analise' ? 'none' : 'flex';
            btnFinanceiro.style.display = lead.pipeline === 'financeiro' ? 'none' : 'flex';
            btnLeads.style.display = lead.pipeline === 'leads' ? 'none' : 'flex';

            // Corretor não pode mover para Financeiro (precisa de Diretor/Admin/Gerente)
            if(currentUser.role === 'Corretor') {
                btnFinanceiro.style.display = 'none';
            }

            // Reset form de financeiro e seleção de etapa
            document.getElementById('mv-financial-form').classList.add('hidden');
            document.getElementById('mv-stage-section').classList.add('hidden');
            document.getElementById('mv-vgv').value = lead.vgv ? formatCurrency(lead.vgv) : '';
            document.getElementById('mv-pct-total').value = lead.commissionPctTotal != null ? lead.commissionPctTotal : 4;
            document.getElementById('mv-pct-corretor').value = lead.commissionPctCorretor != null ? lead.commissionPctCorretor : 2;
            document.getElementById('mv-pct-gerente').value = lead.commissionPctGerente != null ? lead.commissionPctGerente : 10;
            document.getElementById('mv-broker').value = lead.broker || '';
            document.getElementById('mv-sale-date').value = lead.saleDate ? lead.saleDate.split('T')[0] : new Date().toISOString().split('T')[0];
            recalcComissao();

            currentMoveTarget = null;
            openModal('modal-move-client');
        }

        window.moveClientTo = function(targetPipeline) {
            const leadId = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead) return;

            currentMoveTarget = targetPipeline;

            if(targetPipeline === 'financeiro') {
                // Esconde stage selector, mostra formulário financeiro
                document.getElementById('mv-stage-section').classList.add('hidden');
                document.getElementById('mv-financial-form').classList.remove('hidden');
                setTimeout(() => document.getElementById('mv-vgv').focus(), 100);
                return;
            }

            // Para leads e analise: mostrar seleção de etapa
            document.getElementById('mv-financial-form').classList.add('hidden');
            const stageSection = document.getElementById('mv-stage-section');
            const stageSelect = document.getElementById('mv-stage-select');
            
            const stages = PIPELINES[targetPipeline];
            stageSelect.innerHTML = stages.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
            stageSelect.value = stages[0].id; // primeiro estágio por padrão
            
            stageSection.classList.remove('hidden');
            // Scroll para o seletor
            setTimeout(() => stageSection.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
        }

        window.confirmStandardMove = function() {
            const leadId = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead || !currentMoveTarget) return;

            // Para enviar à Análise é obrigatório informar Construtora e Empreendimento
            if(currentMoveTarget === 'analise') {
                const construtoraVal = (document.getElementById('ld-construtora')?.value || lead.construtora || '').trim();
                const projectVal = (document.getElementById('ld-project')?.value || lead.project || '').trim();
                if(!construtoraVal || !projectVal) {
                    showToast('Para enviar à Análise, preencha a Construtora e o Empreendimento no cadastro do lead.', 'error');
                    closeModal('modal-move-client');
                    return;
                }
                // Garante que os valores fiquem salvos no lead
                lead.construtora = construtoraVal;
                lead.project = projectVal;
            }

            const stageId = document.getElementById('mv-stage-select').value;
            const stageName = PIPELINES[currentMoveTarget].find(s => s.id === stageId)?.title || stageId;
            const pipeNames = { leads: 'Pipeline de Leads', analise: 'Análise de Crédito' };

            if(!confirm(`Mover "${lead.name}" para ${pipeNames[currentMoveTarget]} → ${stageName}?`)) return;

            executePipelineMove(lead, currentMoveTarget, null, stageId);
        }

        window.confirmMoveToFinanceiro = function() {
            const leadId = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead) return;

            const vgv = parseCurrency(document.getElementById('mv-vgv').value);
            if(!vgv || vgv <= 0) {
                showToast('VGV é obrigatório para fechar a venda.', 'error');
                document.getElementById('mv-vgv').focus();
                return;
            }

            const c = calcularComissoes(vgv,
                parseFloat(document.getElementById('mv-pct-total').value) || 0,
                parseFloat(document.getElementById('mv-pct-corretor').value) || 0,
                parseFloat(document.getElementById('mv-pct-gerente').value) || 0);
            const broker = document.getElementById('mv-broker').value || lead.broker;
            const saleDate = document.getElementById('mv-sale-date').value || new Date().toISOString().split('T')[0];

            lead.vgv = vgv;
            lead.commissionPctTotal = c.pctTotal;
            lead.commissionPctCorretor = c.pctCorretor;
            lead.commissionPctGerente = c.pctGerente;
            lead.commissionValue = c.bruta;            // comissão total bruta (R$)
            lead.percentualNota = c.pctNota;           // % da nota aplicado
            lead.valorDescontoNota = c.descontoNota;   // desconto da nota (R$)
            lead.comissaoLiquida = c.liquida;          // comissão líquida (R$)
            lead.commissionBroker = c.corretor;        // comissão do corretor (R$)
            lead.comissaoGerente = c.gerente;          // comissão do gerente (R$)
            lead.broker = broker;
            lead.saleDate = saleDate;

            executePipelineMove(lead, 'financeiro', { vgv });
        }

        // Cálculo central das comissões (não altera VGV nem a comissão total bruta)
        function calcularComissoes(vgv, pctTotal, pctCorretor, pctGerente) {
            const pctNota = CONFIG.percentualNota || 0;
            const bruta = vgv * pctTotal / 100;
            const descontoNota = bruta * pctNota / 100;
            const liquida = bruta - descontoNota;
            const corretor = liquida / 2;               // corretor = metade da líquida
            const gerente = liquida * pctGerente / 100; // gerente = % da líquida
            return { vgv, pctTotal, pctCorretor, pctGerente, pctNota, bruta, descontoNota, liquida, corretor, gerente };
        }

        // Recalcula a comissão exibida no formulário de venda
        window.recalcComissao = function() {
            const vgv = parseCurrency(document.getElementById('mv-vgv').value) || 0;
            const c = calcularComissoes(vgv,
                parseFloat(document.getElementById('mv-pct-total').value) || 0,
                parseFloat(document.getElementById('mv-pct-corretor').value) || 0,
                parseFloat(document.getElementById('mv-pct-gerente').value) || 0);
            const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
            set('mv-comissao-total-display', formatCurrency(c.bruta));
            set('mv-desconto-nota-display', formatCurrency(c.descontoNota));
            set('mv-comissao-liquida-display', formatCurrency(c.liquida));
            set('mv-comissao-corretor-display', formatCurrency(c.corretor));
            set('mv-comissao-gerente-display', formatCurrency(c.gerente));
            const notaPct = document.getElementById('mv-nota-pct');
            if(notaPct) notaPct.textContent = c.pctNota;
        }

        function executePipelineMove(lead, targetPipeline, financialData = null, customStage = null) {
            const t = getTime();
            const now = new Date().toISOString();
            const oldPipe = lead.pipeline;
            const oldStage = lead.stageId;
            const pipeNames = { leads: 'Pipeline de Leads', analise: 'Análise de Crédito', financeiro: 'Ganhos / Financeiro' };

            // Define stage inicial em cada pipeline (ou usa customStage se passado)
            const initialStages = { leads: 'aguardando', analise: 'analise-pendente', financeiro: 'venda-gerada' };
            lead.pipeline = targetPipeline;
            lead.stageId = customStage || initialStages[targetPipeline];
            lead.order = 0;
            lead.updatedAt = now;
            lead.updatedBy = currentUser.name;

            const newStageName = PIPELINES[targetPipeline]?.find(s => s.id === lead.stageId)?.title || lead.stageId;

            // Timeline
            lead.timeline.unshift(`[${t}] ${currentUser.name} moveu cliente de "${pipeNames[oldPipe]}" para "${pipeNames[targetPipeline]}" (${newStageName})`);
            if(financialData) {
                lead.timeline.unshift(`[${t}] Venda registrada: VGV ${formatCurrency(financialData.vgv)} | Comissão ${formatCurrency(financialData.commission)}`);
            }

            saveLeadsDB();
            closeModal('modal-move-client');

            // Notificação e toast adequados
            if(targetPipeline === 'financeiro') {
                showToast(`🎉 Venda registrada! ${lead.name} movido para Ganhos.`, 'success');
                addNotification(`💰 Venda fechada: ${lead.name} | VGV ${formatCurrency(lead.vgv)}`, 'success');
                sincronizarPlanilha(lead); // → atualiza planilha com Ganho + VGV + comissões
            } else if(targetPipeline === 'analise') {
                showToast(`${lead.name} enviado para Análise de Crédito.`, 'info');
                addNotification(`Lead "${lead.name}" enviado para Análise`, 'info');
                enviarParaPlanilhaAnalise(lead); // → registra na planilha do Google
            } else {
                showToast(`${lead.name} retornado para o Pipeline de Leads.`, 'info');
                if(lead.naPlanilha) sincronizarPlanilha(lead); // → reconhece a saída do Ganho na planilha
            }

            // Atualiza a view atual
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            // Reabre o modal do lead pra usuário continuar (opcional - aqui só fecha)
            closeModal('modal-lead-details');
        }

        // ====================================================================
        // RANKING DE CORRETORES (dashboard)
        // ====================================================================
        function renderBrokerRanking(leads) {
            const list = document.getElementById('ranking-list');
            const section = document.getElementById('ranking-section');
            if(!list || !section) return;

            // Corretor não vê ranking de outros (esconde a seção)
            if(currentUser.role === 'Corretor') {
                section.classList.add('hidden');
                return;
            }
            section.classList.remove('hidden');

            // Agrupar por broker e somar VGV e vendas
            const ranking = {};
            leads.forEach(l => {
                const b = l.broker || 'Sem corretor';
                if(!ranking[b]) ranking[b] = { name: b, vgv: 0, vendas: 0, leads: 0, aprovados: 0 };
                ranking[b].leads += 1;
                if(l.pipeline === 'financeiro') {
                    ranking[b].vendas += 1;
                    ranking[b].vgv += Number(l.vgv) || Number(l.propertyValue) || 0;
                }
                if((l.pipeline === 'analise' && l.stageId === 'aprovado') || l.pipeline === 'financeiro') {
                    ranking[b].aprovados += 1;
                }
            });

            const sorted = Object.values(ranking)
                .filter(r => r.name !== 'Sem corretor' && r.name !== 'Não Atribuído')
                .sort((a,b) => b.vgv - a.vgv)
                .slice(0, 10);

            if(sorted.length === 0) {
                list.innerHTML = '<div class="text-center py-8 text-slate-500"><i class="fa-solid fa-trophy text-3xl mb-2 block opacity-30"></i><p class="text-sm">Nenhum corretor com vendas no período</p></div>';
                return;
            }

            const maxVgv = Math.max(...sorted.map(r => r.vgv)) || 1;
            const medals = ['🥇', '🥈', '🥉'];

            list.innerHTML = sorted.map((r, i) => {
                const photo = DB.users.find(u => u.name === r.name)?.photo;
                const initials = r.name.substring(0,2).toUpperCase();
                const percent = (r.vgv / maxVgv) * 100;
                const medal = medals[i] || `<span class="text-slate-500 font-bold text-sm">${i+1}º</span>`;
                return `
                <div class="flex items-center gap-4 p-3 rounded-lg hover:bg-slate-800/50 transition-colors border border-slate-700/30">
                    <div class="w-8 text-center text-xl">${medal}</div>
                    ${photo 
                        ? `<img src="${photo}" class="w-10 h-10 rounded-full object-cover">`
                        : `<div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center text-white font-bold text-sm">${initials}</div>`
                    }
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between items-center mb-1">
                            <div class="font-bold text-white truncate">${r.name}</div>
                            <div class="text-emerald-400 font-bold text-sm flex-shrink-0 ml-3">${formatCurrency(r.vgv)}</div>
                        </div>
                        <div class="h-2 bg-slate-800 rounded-full overflow-hidden mb-1">
                            <div class="h-full bg-gradient-to-r from-purple-500 to-blue-500 transition-all" style="width:${percent}%"></div>
                        </div>
                        <div class="flex gap-3 text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                            <span><i class="fa-solid fa-folder-open text-blue-400"></i> ${r.leads} leads</span>
                            <span><i class="fa-solid fa-check text-green-400"></i> ${r.aprovados} aprov.</span>
                            <span><i class="fa-solid fa-handshake text-emerald-400"></i> ${r.vendas} vendas</span>
                        </div>
                    </div>
                </div>`;
            }).join('');
        }

        // ====================================================================
        // MENSAGENS E OBSERVAÇÕES (chat interno do lead)
        // ====================================================================
        window.renderLeadMessages = function(lead) {
            const list = document.getElementById('ld-messages-list');
            const counter = document.getElementById('ld-messages-count');
            const tabCounter = document.getElementById('messages-counter');
            if(!list) return;

            const messages = lead.messages || [];
            if(counter) counter.textContent = `${messages.length} mensage${messages.length === 1 ? 'm' : 'ns'}`;
            if(tabCounter) tabCounter.textContent = messages.length;

            if(messages.length === 0) {
                list.innerHTML = `
                    <div class="text-center py-12">
                        <div class="inline-flex p-4 rounded-full bg-slate-800/60 mb-4"><i class="fa-regular fa-comments text-4xl text-slate-600"></i></div>
                        <p class="text-slate-400 font-bold">Nenhuma mensagem ainda</p>
                        <p class="text-xs text-slate-500 mt-1">Adicione a primeira observação operacional sobre este lead</p>
                    </div>`;
                return;
            }

            // Agrupar por data (mais recentes embaixo)
            const sorted = [...messages].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
            const groups = {};
            sorted.forEach(m => {
                const d = new Date(m.timestamp);
                const key = d.toLocaleDateString('pt-BR');
                if(!groups[key]) groups[key] = [];
                groups[key].push(m);
            });

            const roleColors = {
                'Diretor': 'from-amber-500 to-orange-500',
                'Administrativo': 'from-slate-500 to-slate-600',
                'Gerente': 'from-blue-500 to-cyan-500',
                'Corretor': 'from-emerald-500 to-green-500'
            };

            list.innerHTML = Object.entries(groups).map(([date, msgs]) => `
                <div class="space-y-3">
                    <div class="flex items-center gap-3 my-4">
                        <div class="flex-1 h-px bg-slate-700/50"></div>
                        <span class="text-[10px] font-bold uppercase tracking-widest text-slate-500 bg-slate-800 px-3 py-1 rounded-full border border-slate-700">${date}</span>
                        <div class="flex-1 h-px bg-slate-700/50"></div>
                    </div>
                    ${msgs.map(m => {
                        const dt = new Date(m.timestamp);
                        const time = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                        const initials = (m.author || '?').substring(0,2).toUpperCase();
                        const colorClass = roleColors[m.role] || 'from-slate-500 to-slate-600';
                        const isMe = m.authorId === currentUser?.id;
                        const photo = DB.users.find(u => u.id === m.authorId)?.photo;
                        return `
                        <div class="flex gap-3 ${isMe ? 'flex-row-reverse' : ''}">
                            ${photo 
                                ? `<img src="${photo}" class="w-9 h-9 rounded-full object-cover flex-shrink-0 mt-0.5">`
                                : `<div class="w-9 h-9 rounded-full bg-gradient-to-br ${colorClass} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 mt-0.5">${initials}</div>`
                            }
                            <div class="flex-1 max-w-[80%] ${isMe ? 'text-right' : ''}">
                                <div class="flex items-baseline gap-2 mb-1 ${isMe ? 'justify-end' : ''}">
                                    <span class="text-sm font-bold text-white">${m.author}</span>
                                    <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">${m.role || '—'}</span>
                                    <span class="text-[11px] text-slate-500">${time}</span>
                                </div>
                                <div class="inline-block ${isMe ? 'bg-blue-500/20 border-blue-500/30 text-blue-50' : 'bg-slate-800/80 border-slate-700 text-slate-200'} border rounded-xl px-4 py-3 text-sm leading-relaxed shadow text-left">
                                    ${(m.text || '').replace(/\n/g, '<br>')}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            `).join('');

            // Scroll para baixo
            list.scrollTop = list.scrollHeight;
        }

        window.addLeadMessage = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            const input = document.getElementById('ld-new-message');
            const text = input.value.trim();
            if(!text) { showToast('Digite uma mensagem antes de adicionar.', 'warning'); return; }

            if(!lead.messages) lead.messages = [];
            const now = new Date();
            lead.messages.push({
                id: generateId(),
                text: text,
                author: currentUser.name,
                authorId: currentUser.id,
                role: currentUser.role,
                timestamp: now.toISOString()
            });
            lead.timeline.unshift(`[${getTime()}] ${currentUser.name} adicionou observação na aba Mensagens`);
            lead.updatedAt = now.toISOString();
            lead.updatedBy = currentUser.name;

            saveLeadsDB();
            input.value = '';
            renderLeadMessages(lead);
            renderTimeline(lead);
            showToast('Observação adicionada à conversa.', 'success');

            // Envia email para o corretor do lead (se não for ele mesmo comentando)
            if(SHEETS_URL && lead.broker && lead.broker !== currentUser.name) {
                const corretor = DB.users.find(u => u.name === lead.broker);
                if(corretor && corretor.email) {
                    const leadId = lead.numId ? '#' + String(lead.numId).padStart(4,'0') : '';
                    const pipeNames = { leads: 'Pipeline de Leads', analise: 'Análise de Crédito', financeiro: 'Ganhos / Financeiro', cancelados: 'Cancelados' };
                    const stageName = PIPELINES[lead.pipeline]?.find(s => s.id === lead.stageId)?.title || lead.stageId || '';
                    const logoUrl = SUPABASE_URL + '/storage/v1/object/public/crm-files/system/logo.png';
                    const textoPlano = 'Olá, ' + corretor.name + '!\n\n' +
                        currentUser.name + ' adicionou um comentário no lead abaixo:\n\n' +
                        'LEAD: ' + leadId + ' ' + lead.name + '\n' +
                        (lead.construtora ? 'Construtora: ' + lead.construtora + '\n' : '') +
                        (lead.project ? 'Empreendimento: ' + lead.project + '\n' : '') +
                        'Pipeline: ' + (pipeNames[lead.pipeline] || lead.pipeline) + '\n' +
                        'Etapa: ' + stageName + '\n' +
                        (lead.date ? 'Cadastrado em: ' + lead.date + '\n' : '') +
                        '\nCOMENTÁRIO:\n"' + text + '"\n\nEquipe CRM Audaz';
                    const htmlMensagem = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#0f172a;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#1e293b;border-radius:12px;overflow:hidden;max-width:560px;">
      <tr><td style="background:#0f172a;padding:24px 32px;text-align:center;border-bottom:1px solid #334155;">
        <span style="color:#ffffff;font-size:26px;font-weight:900;letter-spacing:4px;text-transform:uppercase;">CRM AUDAZ</span>
      </td></tr>
      <tr><td style="padding:28px 32px;">
        <p style="color:#94a3b8;font-size:14px;margin:0 0 4px 0;">Olá, <strong style="color:#ffffff;">${corretor.name}</strong>!</p>
        <p style="color:#94a3b8;font-size:14px;margin:0 0 24px 0;"><strong style="color:#3b82f6;">${currentUser.name}</strong> adicionou um comentário no lead abaixo:</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border-radius:8px;border:1px solid #334155;margin-bottom:20px;">
          <tr><td style="padding:16px 20px;border-bottom:1px solid #334155;">
            <p style="margin:0;color:#3b82f6;font-size:18px;font-weight:bold;">${leadId} ${lead.name}</p>
          </td></tr>
          <tr><td style="padding:16px 20px;">
            <table width="100%" cellpadding="0" cellspacing="6">
              ${lead.construtora ? `<tr><td style="color:#64748b;font-size:13px;width:130px;">Construtora</td><td style="color:#e2e8f0;font-size:13px;">${lead.construtora}</td></tr>` : ''}
              ${lead.project ? `<tr><td style="color:#64748b;font-size:13px;">Empreendimento</td><td style="color:#e2e8f0;font-size:13px;">${lead.project}</td></tr>` : ''}
              <tr><td style="color:#64748b;font-size:13px;">Pipeline</td><td style="color:#e2e8f0;font-size:13px;">${pipeNames[lead.pipeline] || lead.pipeline}</td></tr>
              <tr><td style="color:#64748b;font-size:13px;">Etapa</td><td style="color:#e2e8f0;font-size:13px;">${stageName}</td></tr>
              ${lead.date ? `<tr><td style="color:#64748b;font-size:13px;">Cadastrado em</td><td style="color:#e2e8f0;font-size:13px;">${lead.date}</td></tr>` : ''}
            </table>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e3a5f;border-radius:8px;border-left:4px solid #3b82f6;">
          <tr><td style="padding:16px 20px;">
            <p style="margin:0 0 6px 0;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Comentário</p>
            <p style="margin:0;color:#e2e8f0;font-size:15px;line-height:1.6;">${text.replace(/\n/g,'<br>')}</p>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px;border-top:1px solid #334155;text-align:center;">
        <p style="margin:0;color:#475569;font-size:12px;">Equipe CRM Audaz · Premium Real Estate</p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
                    fetch(SHEETS_URL, {
                        method: 'POST', mode: 'no-cors',
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                        body: JSON.stringify({
                            action: 'enviarEmail',
                            para: corretor.email,
                            assunto: 'CRM Audaz — Novo comentário no lead ' + leadId + ' ' + lead.name,
                            mensagem: textoPlano,
                            htmlMensagem: htmlMensagem
                        })
                    });
                }
            }
        }

        // Atalho Ctrl+Enter para enviar
        document.addEventListener('keydown', function(e) {
            if(e.target?.id === 'ld-new-message' && e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                addLeadMessage();
            }
        });

        // ====================================================================
        // CANCELAMENTO DE LEADS
        // ====================================================================
        window.canCancelLead = function(lead) {
            if(!currentUser || !lead) return false;
            const role = currentUser.role;
            if(role === 'Diretor' || role === 'Administrativo') return true;
            if(role === 'Gerente') {
                const myTeam = currentUser.team;
                if(!myTeam) return lead.broker === currentUser.name;
                const teamBrokers = DB.users
                    .filter(u => u.team === myTeam)
                    .map(u => u.name);
                return teamBrokers.includes(lead.broker);
            }
            if(role === 'Corretor') return lead.broker === currentUser.name;
            return false;
        }

        window.openCancelLeadModal = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            if(!canCancelLead(lead)) { showToast('Você não tem permissão para cancelar este lead.', 'error'); return; }

            document.getElementById('cancel-reason').value = '';
            document.getElementById('cancel-obs').value = '';
            openModal('modal-cancel-lead');
            setTimeout(() => document.getElementById('cancel-reason').focus(), 100);
        }

        window.confirmCancelLead = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;

            const reason = document.getElementById('cancel-reason').value;
            const obs = document.getElementById('cancel-obs').value.trim();
            if(!reason) { showToast('Selecione o motivo do cancelamento.', 'error'); return; }

            const now = new Date();
            const t = getTime();
            
            // Salva pipeline/etapa anteriores para possível reativação
            lead.previousPipeline = lead.pipeline;
            lead.previousStage = lead.stageId;
            
            lead.pipeline = 'cancelados';
            lead.stageId = 'cancelado';
            lead.cancelReason = reason;
            lead.cancelObs = obs;
            lead.canceledAt = now.toISOString();
            lead.canceledBy = currentUser.name;
            lead.updatedAt = now.toISOString();
            lead.updatedBy = currentUser.name;
            
            lead.timeline.unshift(`[${t}] ${currentUser.name} CANCELOU o lead. Motivo: ${reason}${obs ? ' | Obs: ' + obs : ''}`);

            // Garante que o cancelamento sempre chegue na planilha se o lead já estava lá
            // (passou por Análise ou Ganhos) — fica vermelho + "Cancelado" como qualquer outro
            if(['analise','financeiro'].includes(lead.previousPipeline) || lead.naPlanilha) {
                lead.naPlanilha = true;
            }

            saveLeadsDB();
            sincronizarPlanilha(lead); // → marca como Cancelado (vermelho) na planilha, se já estava lá
            closeModal('modal-cancel-lead');
            closeModal('modal-lead-details');
            showToast(`Lead "${lead.name}" cancelado. Disponível em "Leads Cancelados".`, 'warning');
            addNotification(`Lead ${lead.name} foi cancelado por ${currentUser.name} | ${reason}`, 'warning');

            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            if(currentView === 'dashboard') renderDashboard();
        }

        window.reactivateLead = function(leadId) {
            const lead = DB.leads.find(l => l.id === leadId);
            if(!lead) return;
            if(!canCancelLead(lead)) { showToast('Sem permissão para reativar este lead.', 'error'); return; }
            if(!confirm(`Reativar o lead "${lead.name}"?\n\nEle voltará para o pipeline anterior (${lead.previousPipeline || 'leads'}).`)) return;

            const t = getTime();
            const now = new Date().toISOString();
            const targetPipe = lead.previousPipeline || 'leads';
            const targetStage = lead.previousStage || PIPELINES[targetPipe]?.[0]?.id || 'aguardando';
            
            lead.pipeline = targetPipe;
            lead.stageId = targetStage;
            lead.reactivatedAt = now;
            lead.reactivatedBy = currentUser.name;
            lead.updatedAt = now;
            lead.updatedBy = currentUser.name;
            lead.timeline.unshift(`[${t}] ${currentUser.name} REATIVOU o lead (cancelamento revertido)`);
            // Mantém cancelReason/canceledAt como histórico, mas marca reativação
            
            saveLeadsDB();
            sincronizarPlanilha(lead); // → atualiza status na planilha após reativar
            renderCancelados();
            showToast(`Lead "${lead.name}" reativado com sucesso!`, 'success');
            addNotification(`${lead.name} foi reativado por ${currentUser.name}`, 'success');
        }

        window.renderCancelados = function() {
            const tbody = document.getElementById('cancelados-tbody');
            if(!tbody) return;

            const search = (document.getElementById('cancel-search')?.value || '').toLowerCase();
            const reason = document.getElementById('cancel-filter-reason')?.value || '';
            
            const allCanceled = DB.leads.filter(l => l.pipeline === 'cancelados');
            // Aplicar regras de visibilidade
            let visible = allCanceled;
            if(currentUser.role === 'Corretor') visible = allCanceled.filter(l => l.broker === currentUser.name);
            else if(currentUser.role === 'Gerente' && currentUser.team) {
                const teamBrokers = DB.users.filter(u => u.team === currentUser.team).map(u => u.name);
                visible = allCanceled.filter(l => teamBrokers.includes(l.broker));
            }

            // Stats
            const totalAll = DB.leads.length;
            const totalCanceled = visible.length;
            const cancelRate = totalAll > 0 ? Math.round((totalCanceled / totalAll) * 100) : 0;
            const reactivated = DB.leads.filter(l => l.reactivatedAt).length;
            const thisMonth = visible.filter(l => {
                if(!l.canceledAt) return false;
                const d = new Date(l.canceledAt);
                const now = new Date();
                return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            }).length;

            document.getElementById('cancel-total').textContent = totalCanceled;
            document.getElementById('cancel-stat-total').textContent = totalCanceled;
            document.getElementById('cancel-stat-month').textContent = thisMonth;
            document.getElementById('cancel-stat-rate').textContent = cancelRate + '%';
            document.getElementById('cancel-stat-reactivated').textContent = reactivated;
            const navCounter = document.getElementById('counter-cancelados');
            if(navCounter) navCounter.textContent = totalCanceled;

            // Aplicar filtros
            let filtered = visible;
            if(search) filtered = filtered.filter(l => 
                (l.name||'').toLowerCase().includes(search) ||
                (l.phone||'').toLowerCase().includes(search) ||
                (l.cpf||'').toLowerCase().includes(search) ||
                (l.broker||'').toLowerCase().includes(search)
            );
            if(reason) filtered = filtered.filter(l => l.cancelReason === reason);

            if(filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="py-16 text-center text-slate-500"><i class="fa-regular fa-face-smile text-4xl mb-3 block opacity-50"></i><p class="font-bold">Nenhum lead cancelado encontrado</p><p class="text-xs mt-1">Ótimo trabalho mantendo a equipe ativa!</p></td></tr>`;
                return;
            }

            // Ordenar por data de cancelamento (mais recentes primeiro)
            filtered.sort((a,b) => new Date(b.canceledAt || 0) - new Date(a.canceledAt || 0));

            const pipeNames = { leads: 'Leads', analise: 'Análise', financeiro: 'Ganhos' };
            tbody.innerHTML = filtered.map(l => {
                const canceledDate = l.canceledAt ? new Date(l.canceledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
                const prevPipe = pipeNames[l.previousPipeline] || '—';
                const canReactivate = canCancelLead(l);
                return `
                <tr class="hover:bg-slate-800/40 transition-colors">
                    <td class="px-4 py-3">
                        <div class="flex items-center gap-3 cursor-pointer" onclick="openLeadDetails('${l.id}')">
                            <div class="w-10 h-10 rounded-full bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center text-white font-bold text-sm">${l.name.substring(0,2).toUpperCase()}</div>
                            <div>
                                <div class="font-bold text-white">${l.name}</div>
                                <div class="text-xs text-slate-500">${l.phone || ''}</div>
                            </div>
                        </div>
                    </td>
                    <td class="px-4 py-3 hidden md:table-cell"><span class="text-sm text-slate-300">${l.broker || '—'}</span></td>
                    <td class="px-4 py-3"><span class="inline-block px-2.5 py-1 rounded-full text-[11px] font-bold bg-red-500/20 text-red-300 border border-red-500/30">${l.cancelReason || 'Sem motivo'}</span>${l.cancelObs ? `<div class="text-[11px] text-slate-500 mt-1 italic">"${l.cancelObs.length > 60 ? l.cancelObs.substring(0,60)+'...' : l.cancelObs}"</div>` : ''}</td>
                    <td class="px-4 py-3 hidden lg:table-cell"><span class="text-xs text-slate-400">${canceledDate}</span><br><span class="text-[10px] text-slate-600">por ${l.canceledBy || '—'}</span></td>
                    <td class="px-4 py-3 hidden lg:table-cell"><span class="text-xs text-slate-300">${prevPipe}</span></td>
                    <td class="px-4 py-3">
                        <div class="flex items-center justify-end gap-1">
                            <button onclick="openLeadDetails('${l.id}')" title="Ver detalhes" class="p-2 rounded-lg hover:bg-blue-500/20 text-blue-300 transition-colors"><i class="fa-solid fa-eye"></i></button>
                            ${canReactivate ? `<button onclick="reactivateLead('${l.id}')" title="Reativar lead" class="p-2 rounded-lg hover:bg-emerald-500/20 text-emerald-300 transition-colors"><i class="fa-solid fa-rotate-left"></i></button>` : ''}
                            ${currentUser.role === 'Diretor' ? `<button onclick="excluirCanceladoPermanente('${l.id}', '${(l.name||'').replace(/'/g,"\\'")}') " title="Excluir permanentemente" class="p-2 rounded-lg hover:bg-red-500/20 text-slate-600 hover:text-red-400 transition-colors"><i class="fa-solid fa-trash text-xs"></i></button>` : ''}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }

        // Exclusão permanente de lead cancelado — somente Diretor
        window.excluirCanceladoPermanente = function(id, nome) {
            if(currentUser.role !== 'Diretor') { showToast('Apenas o Diretor pode excluir permanentemente.', 'error'); return; }
            if(!confirm(`Excluir permanentemente "${nome}"?\n\nEssa ação não pode ser desfeita.`)) return;
            DB.leads = DB.leads.filter(l => l.id !== id);
            saveLeadsDB();
            showToast(`Lead "${nome}" excluído permanentemente.`, 'success');
            renderCancelados();
        }

        // ====================================================================
        // BASE DE TESTES — 20 LEADS + 5 CORRETORES
        // ====================================================================
        window.loadTestBase = function() {
            if(!confirm('Carregar a base de testes?\n\nIsso vai adicionar:\n• 10 corretores\n• 2 gerentes\n• 20 leads de exemplo\n\nLeads e usuários existentes NÃO serão removidos. Deseja continuar?')) return;

            // 2 GERENTES (cada um responsável por uma equipe)
            const TEST_MANAGERS = [
                { name: 'Leonilson Silva', email: 'leonilson@audaz.com', team: 'Blacks', role: 'Gerente' },
                { name: 'Samara Rodrigues', email: 'samara@audaz.com', team: 'Diamond', role: 'Gerente' }
            ];

            // 10 CORRETORES distribuídos nas 3 equipes
            const TEST_BROKERS = [
                { name: 'Thaís Abreu', email: 'thais.abreu@audaz.com', team: 'Blacks' },
                { name: 'Silnara Silva', email: 'silnara.silva@audaz.com', team: 'Diamond' },
                { name: 'Leonilson Silva', email: 'leonilson.silva@audaz.com', team: 'Blacks' },
                { name: 'Janiele Ellen', email: 'janiele.ellen@audaz.com', team: 'Platinum' },
                { name: 'Eduardo Prudêncio', email: 'eduardo.prudencio@audaz.com', team: 'Diamond' },
                { name: 'Rui Castro', email: 'rui.castro@audaz.com', team: 'Blacks' },
                { name: 'Samara Rodrigues Corretora', email: 'samara.corretora@audaz.com', team: 'Diamond' },
                { name: 'Linda Inez', email: 'linda.inez@audaz.com', team: 'Platinum' },
                { name: 'Pablo Jihad', email: 'pablo.jihad@audaz.com', team: 'Platinum' },
                { name: 'Ana Larissa', email: 'ana.larissa@audaz.com', team: 'Blacks' }
            ];

            let addedUsers = 0;

            // Cadastrar gerentes
            TEST_MANAGERS.forEach(m => {
                const exists = DB.users.find(u => u.email === m.email);
                if(!exists) {
                    DB.users.push({
                        id: 'u_' + generateId(),
                        email: m.email, pass: '123456',
                        name: m.name, role: 'Gerente', status: 'Ativo',
                        phone: '', team: m.team, goal: 250000, commission: 1.5,
                        photo: null, lastAccess: null,
                        createdAt: getDateStr(), createdBy: currentUser.id
                    });
                    addedUsers++;
                }
            });

            // Cadastrar/atualizar os corretores
            TEST_BROKERS.forEach(b => {
                const exists = DB.users.find(u => u.email === b.email);
                if(!exists) {
                    DB.users.push({
                        id: 'u_' + generateId(),
                        email: b.email, pass: '123456',
                        name: b.name, role: 'Corretor', status: 'Ativo',
                        phone: '', team: b.team, goal: 80000, commission: 3,
                        photo: null, lastAccess: null,
                        createdAt: getDateStr(), createdBy: currentUser.id
                    });
                    addedUsers++;
                }
            });

            // 20 LEADS distribuídos: 2 por corretor (10 corretores × 2 = 20)
            const TEST_LEADS_TEMPLATES = [
                // Thaís Abreu (Blacks)
                { name: 'João Henrique Costa', phone: '(11) 98700-1001', origin: 'Instagram', pipeline: 'leads', stageId: 'hot', temp: 'Hot', city: 'São Paulo' },
                { name: 'Beatriz Soares', phone: '(11) 98700-1002', origin: 'Facebook', pipeline: 'leads', stageId: 'visita', temp: 'Hot', city: 'Osasco' },
                // Silnara Silva (Diamond)
                { name: 'Carlos Eduardo Mendes', phone: '(11) 98700-2001', origin: 'Site', pipeline: 'leads', stageId: 'aguardando', temp: 'Novo', city: 'São Paulo' },
                { name: 'Roberto Vieira', phone: '(11) 98700-2002', origin: 'Instagram', pipeline: 'analise', stageId: 'aprovado', temp: 'Hot', city: 'Santo André' },
                // Leonilson Silva Corretor (Blacks)
                { name: 'Fernanda Ribeiro', phone: '(11) 98700-3001', origin: 'Indicação', pipeline: 'leads', stageId: 'tratativa', temp: 'Morno', city: 'São Paulo' },
                { name: 'Cristiane Barros', phone: '(11) 98700-3002', origin: 'Instagram', pipeline: 'financeiro', stageId: 'venda-gerada', temp: 'Hot', city: 'São Paulo', vgv: 380000, commissionValue: 11400 },
                // Janiele Ellen (Platinum)
                { name: 'Vanessa Cardoso', phone: '(11) 98700-4001', origin: 'WhatsApp', pipeline: 'leads', stageId: 'visita', temp: 'Hot', city: 'Embu' },
                { name: 'Larissa Moreira', phone: '(11) 98700-4002', origin: 'Indicação', pipeline: 'financeiro', stageId: 'assinatura', temp: 'Hot', city: 'Cotia', vgv: 420000, commissionValue: 12600 },
                // Eduardo Prudêncio (Diamond)
                { name: 'Camila Duarte', phone: '(11) 98700-5001', origin: 'Site', pipeline: 'leads', stageId: 'doc-recebida', temp: 'Hot', city: 'São Paulo' },
                { name: 'Aline Cavalcante', phone: '(11) 98700-5002', origin: 'Google', pipeline: 'financeiro', stageId: 'entrada-pendente', temp: 'Hot', city: 'Barueri', vgv: 510000, commissionValue: 15300 },
                // Rui Castro (Blacks)
                { name: 'Anderson Lima', phone: '(11) 98700-6001', origin: 'Facebook', pipeline: 'analise', stageId: 'com-pendencia', temp: 'Morno', city: 'Mauá' },
                { name: 'Diego Martins', phone: '(11) 98700-6002', origin: 'Site', pipeline: 'leads', stageId: 'compareceu', temp: 'Hot', city: 'Taboão da Serra' },
                // Samara Corretora (Diamond)
                { name: 'Patrícia Nunes', phone: '(11) 98700-7001', origin: 'WhatsApp', pipeline: 'leads', stageId: 'hot', temp: 'Hot', city: 'Diadema' },
                { name: 'Juliana Pacheco', phone: '(11) 98700-7002', origin: 'Google', pipeline: 'leads', stageId: 'doc-recebida', temp: 'Hot', city: 'São Bernardo' },
                // Linda Inez (Platinum)
                { name: 'Bruno Carvalho', phone: '(11) 98700-8001', origin: 'Instagram', pipeline: 'leads', stageId: 'hot', temp: 'Hot', city: 'Itapevi' },
                { name: 'Felipe Andrade', phone: '(11) 98700-8002', origin: 'Google', pipeline: 'analise', stageId: 'aprovado', temp: 'Hot', city: 'São Paulo' },
                // Pablo Jihad (Platinum)
                { name: 'Mariana Lopes', phone: '(11) 98700-9001', origin: 'Google', pipeline: 'leads', stageId: 'tratativa', temp: 'Morno', city: 'Guarulhos' },
                { name: 'Thiago Macedo', phone: '(11) 98700-9002', origin: 'Facebook', pipeline: 'analise', stageId: 'em-analise', temp: 'Morno', city: 'Carapicuíba' },
                // Ana Larissa (Blacks)
                { name: 'Ricardo Almeida', phone: '(11) 98700-1003', origin: 'Indicação', pipeline: 'analise', stageId: 'em-analise', temp: 'Hot', city: 'São Paulo' },
                { name: 'Marcelo Tavares', phone: '(11) 98700-1004', origin: 'WhatsApp', pipeline: 'leads', stageId: 'tratativa', temp: 'Morno', city: 'Jandira' }
            ];

            const now = new Date().toISOString();
            const today = getDateStr();
            const t = getTime();
            let addedLeads = 0;
            
            TEST_LEADS_TEMPLATES.forEach((tpl, idx) => {
                // 2 leads por corretor: idx 0,1 → broker 0; idx 2,3 → broker 1; ...
                const brokerIdx = Math.floor(idx / 2);
                const broker = TEST_BROKERS[brokerIdx];
                if(!broker) return;
                
                // Evita duplicar leads de teste
                if(DB.leads.find(l => l.phone === tpl.phone)) return;

                const lead = {
                    id: generateId(),
                    numId: nextNumId(),
                    name: tpl.name, phone: tpl.phone,
                    email: tpl.name.toLowerCase().replace(/\s+/g, '.').normalize('NFD').replace(/[\u0300-\u036f]/g, '') + '@email.com',
                    origin: tpl.origin, city: tpl.city,
                    broker: broker.name,
                    pipeline: tpl.pipeline, stageId: tpl.stageId, order: 0,
                    temp: tpl.temp,
                    tags: [], docs: ['rg','cpf'], files: [],
                    timeline: [
                        `[${t}] Lead criado automaticamente (base de testes)`,
                        `[${t}] Atribuído a ${broker.name} (${broker.team})`
                    ],
                    messages: [{
                        id: generateId(),
                        text: `Lead da base de testes — equipe ${broker.team}. Cliente interessado em imóveis na região de ${tpl.city}.`,
                        author: broker.name, authorId: 'system-test', role: 'Corretor',
                        timestamp: now
                    }],
                    date: today, createdAt: now, updatedAt: now, updatedBy: broker.name,
                    vgv: tpl.vgv || 0,
                    propertyValue: tpl.vgv || 0,
                    commissionValue: tpl.commissionValue || 0,
                    saleDate: tpl.pipeline === 'financeiro' ? today : null
                };
                DB.leads.push(lead);
                addedLeads++;
            });

            saveUsersDB();
            saveLeadsDB();
            populateBrokerDropdowns();
            updateNavCounters();

            const msg = `Base de testes carregada! ${addedUsers} usuários (incluindo 2 gerentes) e ${addedLeads} leads adicionados.`;
            showToast(msg, 'success');
            addNotification(msg, 'success');

            if(['leads','analise','financeiro','cancelados'].includes(currentView)) renderKanban(currentPipeline);
            if(currentView === 'dashboard') renderDashboard();
            if(currentView === 'users') renderUsersTable();
        }

        window.updateTeamDisplay = function() {
            const brokerName = document.getElementById('ld-broker')?.value;
            const teamDisplay = document.getElementById('ld-team-display');
            if(!teamDisplay) return;
            const brokerUser = DB.users.find(u => u.name === brokerName);
            teamDisplay.value = brokerUser?.team || '—';
        }

        // Mudar etapa via select do HEADER (visível ao usuário)
        window.changeStageFromHeader = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            const newStageId = document.getElementById('ld-stage-header').value;
            if(!newStageId || newStageId === lead.stageId) return;
            
            const stageName = PIPELINES[lead.pipeline]?.find(s => s.id === newStageId)?.title || newStageId;
            const t = getTime();
            lead.stageId = newStageId;
            lead.order = 0;
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;
            lead.timeline.unshift(`[${t}] ${currentUser.name} alterou etapa para: ${stageName}`);

            // Registra data/mês de aprovação na primeira vez que chega em Aprovado
            if(lead.pipeline === 'analise' && newStageId === 'aprovado' && !lead.dataAprovacao) {
                const na = new Date();
                lead.dataAprovacao = na.toLocaleDateString('pt-BR');
                lead.mesAprovacao = labelMesComercial(na);
            }

            saveLeadsDB();
            sincronizarStatusAnalise(lead); // → atualiza status na planilha (se estiver em Análise)
            renderTimeline(lead);

            // Sincroniza o select oculto também
            const stageEditableOld = document.getElementById('ld-stage-editable');
            if(stageEditableOld) stageEditableOld.value = newStageId;
            
            // Atualiza Datas & Histórico
            const updatedDisplay = document.getElementById('ld-updated-display');
            if(updatedDisplay) updatedDisplay.textContent = new Date(lead.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const updatedByDisplay = document.getElementById('ld-updated-by-display');
            if(updatedByDisplay) updatedByDisplay.textContent = lead.updatedBy;
            
            // Re-render kanban se está visível
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            
            showToast(`Etapa alterada para "${stageName}"`, 'success');
        }

        // Mudar etapa diretamente no modal (dentro do mesmo pipeline) — mantida pra compat
        window.changeStageFromModal = function() {
            const id = document.getElementById('ld-id').value;
            const lead = DB.leads.find(l => l.id === id);
            if(!lead) return;
            const newStageId = document.getElementById('ld-stage-editable').value;
            if(!newStageId || newStageId === lead.stageId) return;
            
            const stageName = PIPELINES[lead.pipeline]?.find(s => s.id === newStageId)?.title || newStageId;
            const t = getTime();
            lead.stageId = newStageId;
            lead.order = 0;
            lead.updatedAt = new Date().toISOString();
            lead.updatedBy = currentUser.name;
            lead.timeline.unshift(`[${t}] ${currentUser.name} alterou etapa para: ${stageName}`);

            // Registra data/mês de aprovação na primeira vez que chega em Aprovado
            if(lead.pipeline === 'analise' && newStageId === 'aprovado' && !lead.dataAprovacao) {
                const na = new Date();
                lead.dataAprovacao = na.toLocaleDateString('pt-BR');
                lead.mesAprovacao = labelMesComercial(na);
            }

            saveLeadsDB();
            sincronizarStatusAnalise(lead); // → atualiza status na planilha (se estiver em Análise)
            renderTimeline(lead);

            // Atualiza o badge no header
            const sBadge = document.getElementById('ld-stage-badge');
            if(sBadge) sBadge.textContent = stageName;
            
            // Atualiza Datas & Histórico
            const updatedDisplay = document.getElementById('ld-updated-display');
            if(updatedDisplay) updatedDisplay.textContent = new Date(lead.updatedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const updatedByDisplay = document.getElementById('ld-updated-by-display');
            if(updatedByDisplay) updatedByDisplay.textContent = lead.updatedBy;
            
            // Re-render kanban se está visível
            if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            
            showToast(`Etapa alterada para "${stageName}"`, 'success');
        }

        // Boot
        window.onload = checkAuth;

        // ====================================================================
        // FOLLOW-UP PICKER — calendário customizado
        // ====================================================================
        let _fuLeadId = null;
        let _fuPickerDate = new Date();

        const MESES_PICKER = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        const DIAS_SEMANA = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

        window.openFollowUpPicker = function(e, leadId) {
            e.stopPropagation();
            _fuLeadId = leadId;
            const lead = DB.leads.find(l => l.id === leadId);
            _fuPickerDate = lead?.followUp ? new Date(lead.followUp) : new Date();
            // Se não tem follow-up, avança 1 hora
            if(!lead?.followUp) _fuPickerDate.setHours(_fuPickerDate.getHours() + 1, 0, 0, 0);

            renderFuPicker();
            const popup = document.getElementById('fu-picker-popup');
            popup.classList.remove('hidden');
            // Posiciona próximo ao botão clicado (position: fixed = relativo à viewport)
            const rect = e.target.closest('button').getBoundingClientRect();
            const popupW = 288, popupH = popup.offsetHeight || 360;
            // Horizontal: não deixa sair pela direita nem pela esquerda
            let left = Math.min(rect.left, window.innerWidth - popupW - 12);
            left = Math.max(12, left);
            // Vertical: abre abaixo; se não couber, abre acima do botão
            let top = rect.bottom + 8;
            if(top + popupH > window.innerHeight - 12) {
                top = Math.max(12, rect.top - popupH - 8);
            }
            popup.style.left = left + 'px';
            popup.style.top = top + 'px';
        };

        function renderFuPicker() {
            const y = _fuPickerDate.getFullYear(), m = _fuPickerDate.getMonth();
            document.getElementById('fu-picker-month-label').textContent = MESES_PICKER[m] + ' ' + y;
            // Hora e minuto
            document.getElementById('fu-picker-hour').value = _fuPickerDate.getHours();
            document.getElementById('fu-picker-min').value = Math.floor(_fuPickerDate.getMinutes() / 15) * 15;
            // Grid de dias
            const grid = document.getElementById('fu-picker-grid');
            const firstDay = new Date(y, m, 1).getDay();
            const daysInMonth = new Date(y, m + 1, 0).getDate();
            const today = new Date();
            let html = DIAS_SEMANA.map(d => `<div class="text-center text-[10px] text-slate-500 font-bold py-1">${d}</div>`).join('');
            for(let i = 0; i < firstDay; i++) html += '<div></div>';
            for(let d = 1; d <= daysInMonth; d++) {
                const isSelected = d === _fuPickerDate.getDate() && m === _fuPickerDate.getMonth() && y === _fuPickerDate.getFullYear();
                const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
                const isPast = new Date(y, m, d) < new Date(today.getFullYear(), today.getMonth(), today.getDate());
                html += `<button onclick="fuPickerSelectDay(${d})" class="w-8 h-8 rounded-lg text-sm font-medium transition-all mx-auto flex items-center justify-center
                    ${isSelected ? 'bg-blue-600 text-white font-bold shadow-lg' : isPast ? 'text-slate-600 hover:bg-slate-700 hover:text-slate-300' : isToday ? 'border border-blue-500/50 text-blue-300 hover:bg-blue-600/20' : 'text-slate-300 hover:bg-slate-600'}">${d}</button>`;
            }
            grid.innerHTML = html;
        }

        window.fuPickerPrevMonth = function() {
            _fuPickerDate.setMonth(_fuPickerDate.getMonth() - 1);
            renderFuPicker();
        };
        window.fuPickerNextMonth = function() {
            _fuPickerDate.setMonth(_fuPickerDate.getMonth() + 1);
            renderFuPicker();
        };
        window.fuPickerSelectDay = function(d) {
            _fuPickerDate.setDate(d);
            renderFuPicker();
        };
        window.fuPickerConfirm = function() {
            const h = parseInt(document.getElementById('fu-picker-hour').value);
            const min = parseInt(document.getElementById('fu-picker-min').value);
            _fuPickerDate.setHours(h, min, 0, 0);
            const lead = DB.leads.find(l => l.id === _fuLeadId);
            if(lead) {
                lead.followUp = _fuPickerDate.toISOString();
                saveLeadsDB();
                // Atualiza o slot inteiro do card com o novo fuRow
                const card = document.querySelector(`[data-id="${_fuLeadId}"]`);
                if(card) {
                    const fi = followUpInfo(lead.followUp);
                    const slot = card.querySelector('.fu-badge-slot');
                    if(slot && fi) {
                        slot.outerHTML = `<div class="fu-badge-slot flex items-center gap-1.5 mt-2">
                            <span class="fu-badge inline-flex items-center gap-1 px-2 py-0.5 rounded ${fi.overdue?'bg-red-500/15 text-red-400':'bg-blue-500/15 text-blue-300'} text-[10px] font-semibold pointer-events-none"><i class="fa-solid fa-clock text-[9px]"></i>${fi.text}</span>
                            <button onclick="openFollowUpPicker(event,'${_fuLeadId}')" title="Editar follow-up" class="w-5 h-5 rounded ${fi.overdue?'text-red-400 hover:bg-red-500':'text-blue-400 hover:bg-blue-500'} hover:text-white transition-all flex items-center justify-center text-[10px]"><i class="fa-solid fa-pen"></i></button>
                        </div>`;
                    }
                }
                // Atualiza o cabeçalho do modal do lead se estiver aberto para este lead
                const ldIdEl = document.getElementById('ld-id');
                if(ldIdEl && ldIdEl.value === _fuLeadId) {
                    const fi = followUpInfo(lead.followUp);
                    const fuSpan = fi
                        ? `<span id="ld-fu-badge" class="text-[11px] px-2.5 py-1 rounded font-bold ml-2 align-middle ${fi.overdue ? 'bg-red-500 text-white' : 'bg-blue-600 text-white'}"><i class="fa-solid fa-clock mr-1"></i>${fi.text}</span><button onclick="openFollowUpPicker(event,'${lead.id}')" class="text-[11px] px-2.5 py-1 rounded font-bold ml-1 align-middle bg-slate-700 hover:bg-blue-600 text-slate-300 hover:text-white transition-all"><i class="fa-solid fa-clock mr-1"></i>Follow-up</button>`
                        : `<button onclick="openFollowUpPicker(event,'${lead.id}')" class="text-[11px] px-2.5 py-1 rounded font-medium ml-2 align-middle bg-slate-700 hover:bg-blue-600 text-slate-400 hover:text-white transition-all"><i class="fa-solid fa-calendar-plus mr-1"></i>Follow-up</button>`;
                    const nameEl = document.getElementById('ld-name');
                    if(nameEl) nameEl.innerHTML = `${lead.numId ? '<span class="text-blue-400 text-lg align-middle mr-1">'+formatNumId(lead.numId)+'</span>' : ''}${lead.name}${fuSpan}`;
                }
                showToast('Follow-up agendado: ' + _fuPickerDate.toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}), 'success');
                // Re-renderiza o kanban para reposicionar o card pela urgência do follow-up
                if(['leads','analise','financeiro'].includes(currentView)) renderKanban(currentPipeline);
            }
            document.getElementById('fu-picker-popup').classList.add('hidden');
        };
        window.fuPickerCancel = function() {
            document.getElementById('fu-picker-popup').classList.add('hidden');
        };
        // Fecha ao clicar fora
        document.addEventListener('click', function(e) {
            const popup = document.getElementById('fu-picker-popup');
            if(popup && !popup.classList.contains('hidden') && !popup.contains(e.target)) {
                popup.classList.add('hidden');
            }
        });

        // Atualiza badges de follow-up no kanban a cada minuto
        setInterval(() => {
            document.querySelectorAll('.fu-badge').forEach(el => {
                const card = el.closest('[data-id]');
                if(!card) return;
                const lead = DB.leads.find(l => l.id === card.dataset.id);
                if(!lead || !lead.followUp) return;
                const fi = followUpInfo(lead.followUp);
                if(!fi) return;
                el.className = `fu-badge inline-flex items-center gap-1 px-2 py-0.5 rounded ${fi.overdue ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-300'} text-[10px] font-semibold pointer-events-none`;
                el.innerHTML = `<i class="fa-solid fa-clock text-[9px]"></i>${fi.text}`;
            });
        }, 60000);
