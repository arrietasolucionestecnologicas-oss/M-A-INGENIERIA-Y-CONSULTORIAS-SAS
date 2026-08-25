package com.michael.tms.db

import kotlin.math.sqrt

/**
 * Datos normativos IEEE/IEC de grupos de conexión, sembrados en vector_group_reference
 * al iniciar la aplicación si la tabla está vacía. Dyn5 y Dyn11 son obligatorios por ser
 * los predominantes en la zona de operación (requerimiento explícito del cliente).
 */
object VectorGroupSeed {
    data class Seed(
        val code: String,
        val windingConfig: String,
        val phaseShiftDegrees: Int?,
        val ratioMultiplier: Double
    )

    private val SQRT3 = sqrt(3.0)

    val defaults = listOf(
        Seed("Dyn11", "DELTA-ESTRELLA", 330, SQRT3),
        Seed("Dyn5", "DELTA-ESTRELLA", 150, SQRT3),
        Seed("Dyn1", "DELTA-ESTRELLA", 30, SQRT3),
        Seed("Dyn7", "DELTA-ESTRELLA", 210, SQRT3),
        Seed("Yyn0", "ESTRELLA-ESTRELLA", 0, 1.0),
        Seed("Yyn6", "ESTRELLA-ESTRELLA", 180, 1.0),
        Seed("Yd1", "ESTRELLA-DELTA", 30, 1.0 / SQRT3),
        Seed("Yd11", "ESTRELLA-DELTA", 330, 1.0 / SQRT3),
        Seed("Dd0", "DELTA-DELTA", 0, 1.0),
        Seed("Ynd1", "ESTRELLA(N)-DELTA", 30, 1.0 / SQRT3),
        Seed("Ynd11", "ESTRELLA(N)-DELTA", 330, 1.0 / SQRT3),
        Seed("CUSTOM", "PERSONALIZADO", null, 1.0)
    )
}
