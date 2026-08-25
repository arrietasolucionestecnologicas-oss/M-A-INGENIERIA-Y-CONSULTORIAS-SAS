package com.michael.tms.service

import java.time.LocalDate
import java.time.LocalDateTime

fun LocalDateTime.iso(): String = this.toString()
fun LocalDate.iso(): String = this.toString()
