package com.michael.tms.model

enum class PhaseType {
    MONOFASICO,
    TRIFASICO
}

enum class TenantPlan {
    BASIC,
    PRO,
    ENTERPRISE
}

enum class UserRole {
    ADMINISTRADOR,
    SUPERVISOR,
    TECNICO,
    VISUALIZADOR
}

enum class TransformerStatus {
    ACTIVO,
    FUERA_SERVICIO,
    BAJA
}

enum class SessionStatus {
    BORRADOR,
    EN_PROCESO,
    COMPLETADO,
    APROBADO
}

enum class TestType {
    TTR,
    RESISTENCIA_DEVANADOS,
    AISLAMIENTO
}

enum class TestVerdict {
    APROBADO,
    RECHAZADO,
    OBSERVADO,
    PENDIENTE
}

enum class AttachmentType {
    PLACA,
    TERMOGRAFIA,
    FOTO_GENERAL,
    INFORME_PDF
}
