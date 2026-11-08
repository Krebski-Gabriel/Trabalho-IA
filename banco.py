"""
banco.py — Banco de dados MySQL para o projeto de navegação marítima.

Tabelas:
  rotas         — cada cálculo de rota (3 registros por cálculo: comercial, astar, copiloto_ia)
  chat_historico — mensagens trocadas com o Copiloto IA

Requisito:
  .venv\Scripts\python.exe -m pip install pymysql
"""

import pymysql
import pymysql.cursors
from datetime import datetime

# Configuração da conexão
DB_CONFIG = {
    "host":        "localhost",
    "user":        "root",
    "password":    "",
    "database":    "navegacao_maritima",
    "cursorclass": pymysql.cursors.DictCursor,
}


def _conectar():
    return pymysql.connect(**DB_CONFIG)


def init():
    """Verifica conexão com o banco na inicialização."""
    try:
        conn = _conectar()
        conn.close()
        print("[BANCO] Conexão com MySQL estabelecida — navegacao_maritima")
    except Exception as e:
        print(f"[BANCO] Aviso: não foi possível conectar ao MySQL: {e}")
        print("[BANCO] O servidor funciona normalmente sem o banco.")


def salvar_rotas(result, origem="", destino="", velocidade=18.0, emergencia=False):
    """
    Salva as rotas retornadas por compute_three_routes.
    - emergencia=False: salva comercial, astar e copiloto_ia (3 registros)
    - emergencia=True:  salva só astar (1 registro — porto mais próximo)
    Retorna o id do último registro inserido.
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

    ultimo_id = None
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
                origem,
                destino,
                agora,
                tipo,
                round(velocidade, 2),
                round(km * KM_TO_NM, 1),
                round(hrs, 2),
                round(fuel, 2),
                round(economia_usd, 2),
                round(co2_evitado, 2),
            ))

            if tipo == "copiloto_ia":
                ultimo_id = cursor.lastrowid

        conn.commit()
        cursor.close()
        conn.close()

        if ultimo_id:
            print(f"[BANCO] Rota salva — id copiloto_ia: {ultimo_id} | {origem} → {destino}")

    except Exception as e:
        print(f"[BANCO] Erro ao salvar rota: {e}")

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


def listar_rotas(limite=50):
    """Retorna as últimas rotas calculadas."""
    try:
        conn = _conectar()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM rotas ORDER BY id DESC LIMIT %s", (limite,))
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return rows
    except Exception as e:
        print(f"[BANCO] Erro ao listar rotas: {e}")
        return []


def estatisticas():
    """Retorna totais acumulados do banco."""
    try:
        conn = _conectar()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                COUNT(*)              AS total_calculos,
                SUM(co2_evitado_tons) AS co2_total_evitado,
                SUM(economia_usd)     AS economia_total_usd,
                SUM(combustivel_tons) AS combustivel_total
            FROM rotas
            WHERE tipo_rota = 'copiloto_ia'
        """)
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row or {}
    except Exception as e:
        print(f"[BANCO] Erro ao buscar estatísticas: {e}")
        return {}