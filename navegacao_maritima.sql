-- banco.sql — estrutura do banco de dados do projeto Navegação Marítima Inteligente
-- Execute este script no phpMyAdmin ou MySQL para criar o banco e as tabelas.
--
-- Pré-requisito: ter o XAMPP instalado com o MySQL rodando.
-- Após criar o banco, instale o conector Python:
--   python -m pip install pymysql

CREATE DATABASE IF NOT EXISTS navegacao_maritima
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE navegacao_maritima;

-- Rotas calculadas (3 registros por cálculo normal: comercial, astar, copiloto_ia)
-- Rotas de emergência geram 1 registro (astar).
CREATE TABLE IF NOT EXISTS rotas (
    id               INT AUTO_INCREMENT PRIMARY KEY,
    origem           VARCHAR(100),
    destino          VARCHAR(100),
    data_calculo     DATETIME NOT NULL,
    tipo_rota        ENUM('comercial', 'astar', 'copiloto_ia') NOT NULL,
    velocidade_nos   DECIMAL(5,2),
    distancia_nm     DECIMAL(10,1),
    duracao_horas    DECIMAL(8,2),
    combustivel_tons DECIMAL(10,2),
    economia_usd     DECIMAL(12,2),
    co2_evitado_tons DECIMAL(10,2)
);

-- Mensagens geradas pelo Copiloto IA (parecer técnico vinculado à rota copiloto_ia)
CREATE TABLE IF NOT EXISTS chat_historico (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    rota_id   INT,
    data_hora DATETIME NOT NULL,
    remetente ENUM('usuario', 'copiloto') NOT NULL,
    mensagem  TEXT NOT NULL,
    FOREIGN KEY (rota_id) REFERENCES rotas(id) ON DELETE CASCADE
);

-- Banco criado com a versão antiga deste script (sem ON DELETE CASCADE)?
-- Não é obrigatório mudar: o banco.py já apaga o chat antes de apagar a rota.
-- Se quiser deixar igual ao script novo, rode no phpMyAdmin (aba SQL):
--   SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
--    WHERE TABLE_SCHEMA = 'navegacao_maritima' AND TABLE_NAME = 'chat_historico'
--      AND REFERENCED_TABLE_NAME = 'rotas';
--   ALTER TABLE chat_historico DROP FOREIGN KEY <nome_que_apareceu_acima>;
--   ALTER TABLE chat_historico ADD CONSTRAINT fk_chat_rota
--     FOREIGN KEY (rota_id) REFERENCES rotas(id) ON DELETE CASCADE;
