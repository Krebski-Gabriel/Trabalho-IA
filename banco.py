from datetime import datetime

try:
    import pymysql
    import pymysql.cursors
except ImportError:  # sem pymysql o servidor continua subindo; só o banco fica indisponível
    pymysql = None

# Configuração da conexão
DB_CONFIG = {
    "host":     "localhost",
    "user":     "root",
    "password": "",
    "database": "navegacao_maritima",
    "charset":  "utf8mb4",
}

# Campos que o usuário pode editar pelo site (os números vêm do cálculo e não são editáveis)
CAMPOS_EDITAVEIS = {"origem": 100, "destino": 100}  # nome -> tamanho máximo (VARCHAR)


def _conectar():
    if pymysql is None:
        raise RuntimeError("pymysql não instalado. Rode:  python -m pip install pymysql")
    return pymysql.connect(cursorclass=pymysql.cursors.DictCursor, **DB_CONFIG)


def init():
    """Verifica conexão com o banco na inicialização."""
    try:
        conn = _conectar()
        conn.close()
        print("[BANCO] Conexão com MySQL estabelecida — navegacao_maritima")
    except Exception as e:
        print(f"[BANCO] Aviso: não foi possível conectar ao MySQL: {e}")
        print("[BANCO] O servidor funciona normalmente sem o banco.")


# ---------------------------------------------------------------- CREATE

def salvar_rotas(result, origem="", destino="", velocidade=18.0, emergencia=False):
    """
    Salva as rotas retornadas por compute_three_routes.
    - emergencia=False: salva comercial, astar e copiloto_ia (3 registros)
    - emergencia=True:  salva só astar (1 registro — porto mais próximo)
    Retorna o id do registro ao qual o chat deve ser vinculado
    (copiloto_ia nas rotas normais, astar nas de emergência).
    """
    agora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    KM_TO_NM = 0.539957

    if emergencia:
        tipos = {
            "astar": result.get("astar", {}),
        }
        fuel_ref = 0.0
    else:
        tipos = {
            "comercial":   result.get("baseline", {}),
            "astar":       result.get("astar", {}),
            "copiloto_ia": result.get("llm", {}),
        }
        comm = result.get("baseline", {})
        fuel_ref = comm.get("fuel_tons", 0) or 0

    ids = {}
    try:
        conn = _conectar()
        cursor = conn.cursor()

        for tipo, dados in tipos.items():
            if not dados:
                continue

            fuel = dados.get("fuel_tons", 0) or 0
            km   = dados.get("km", 0) or 0
            hrs  = dados.get("hours", 0) or 0

            economia_usd = max(0.0, (fuel_ref - fuel) * 600)
            co2_evitado  = max(0.0, (fuel_ref - fuel) * 3.1)

            cursor.execute("""
                INSERT INTO rotas
                    (origem, destino, data_calculo, tipo_rota, velocidade_nos,
                     distancia_nm, duracao_horas, combustivel_tons, economia_usd, co2_evitado_tons)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                origem or "",
                destino or "",
                agora,
                tipo,
                round(velocidade, 2),
                round(km * KM_TO_NM, 1),
                round(hrs, 2),
                round(fuel, 2),
                round(economia_usd, 2),
                round(co2_evitado, 2),
            ))
            ids[tipo] = cursor.lastrowid

        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"[BANCO] Erro ao salvar rota: {e}")

    # antes só o id da copiloto_ia era devolvido, e a emergência (só astar) ficava sem id
    ultimo_id = ids.get("copiloto_ia") or ids.get("astar")
    if ultimo_id:
        print(f"[BANCO] Rota salva — id {ultimo_id} | {origem or '?'} → {destino or '?'}")
    return ultimo_id


def salvar_chat(rota_id, remetente, mensagem):
    """Salva uma mensagem do chat. remetente: 'usuario' ou 'copiloto'"""
    agora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        conn = _conectar()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO chat_historico (rota_id, data_hora, remetente, mensagem)
            VALUES (%s, %s, %s, %s)
        """, (rota_id, agora, remetente, mensagem))
        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"[BANCO] Erro ao salvar chat: {e}")


# ---------------------------------------------------------------- READ
# As funções de leitura/edição/exclusão deixam o erro subir: o servidor
# devolve 500 com a mensagem, e o site mostra "MySQL desligado" em vez de
# uma lista vazia enganosa.

def listar_rotas(limite=50, busca=""):
    """Retorna as últimas rotas calculadas, com a quantidade de mensagens de chat de cada uma."""
    limite = max(1, min(int(limite or 50), 500))
    sql = """
        SELECT r.*,
               (SELECT COUNT(*) FROM chat_historico c WHERE c.rota_id = r.id) AS total_chat
        FROM rotas r
    """
    params = []
    if busca:
        sql += " WHERE r.origem LIKE %s OR r.destino LIKE %s"
        params += [f"%{busca}%", f"%{busca}%"]
    sql += " ORDER BY r.id DESC LIMIT %s"
    params.append(limite)

    conn = _conectar()
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchall()
    finally:
        conn.close()


def obter_rota(rota_id):
    """Retorna uma rota com as mensagens de chat vinculadas, ou None se não existir."""
    conn = _conectar()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT * FROM rotas WHERE id = %s", (rota_id,))
            rota = cursor.fetchone()
            if not rota:
                return None
            cursor.execute("""
                SELECT id, data_hora, remetente, mensagem
                FROM chat_historico WHERE rota_id = %s ORDER BY id
            """, (rota_id,))
            rota["chat"] = cursor.fetchall()
            return rota
    finally:
        conn.close()


def estatisticas():
    """Retorna totais acumulados do banco."""
    conn = _conectar()
    try:
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT
                    COUNT(*)                          AS total_calculos,
                    COALESCE(SUM(co2_evitado_tons), 0) AS co2_total_evitado,
                    COALESCE(SUM(economia_usd), 0)     AS economia_total_usd,
                    COALESCE(SUM(combustivel_tons), 0) AS combustivel_total
                FROM rotas
                WHERE tipo_rota = 'copiloto_ia'
            """)
            stats = cursor.fetchone() or {}
            cursor.execute("SELECT COUNT(*) AS n FROM rotas")
            stats["total_registros"] = cursor.fetchone()["n"]
            return stats
    finally:
        conn.close()


# ---------------------------------------------------------------- UPDATE

def atualizar_rota(rota_id, dados):
    """
    Atualiza os campos editáveis (origem, destino) de uma rota.
    Retorna a rota atualizada, ou None se o id não existir.
    Lança ValueError se nada válido foi enviado.
    """
    campos = {}
    for nome, tamanho in CAMPOS_EDITAVEIS.items():
        if nome in dados:
            valor = str(dados[nome] or "").strip()
            if len(valor) > tamanho:
                raise ValueError(f"'{nome}' pode ter no máximo {tamanho} caracteres")
            campos[nome] = valor
    if not campos:
        raise ValueError("envie 'origem' e/ou 'destino'")

    sets = ", ".join(f"{nome} = %s" for nome in campos)  # nomes vêm da lista fixa acima
    conn = _conectar()
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM rotas WHERE id = %s", (rota_id,))
            if not cursor.fetchone():
                return None
            cursor.execute(f"UPDATE rotas SET {sets} WHERE id = %s",
                           list(campos.values()) + [rota_id])
        conn.commit()
    finally:
        conn.close()
    return obter_rota(rota_id)


# ---------------------------------------------------------------- DELETE

def excluir_rota(rota_id):
    """
    Exclui uma rota e as mensagens de chat vinculadas a ela.
    (Apaga o chat antes para funcionar mesmo em bancos criados sem ON DELETE CASCADE.)
    Retorna True se excluiu, False se o id não existia.
    """
    conn = _conectar()
    try:
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM chat_historico WHERE rota_id = %s", (rota_id,))
            n = cursor.execute("DELETE FROM rotas WHERE id = %s", (rota_id,))
        conn.commit()
        return n > 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
