# beakless.S  rv32im
# 0x60000000  uart   0x60000004  heart
# 0x60000008  h2     0x6000000c  sleep

        li    s0, 0x60000000
        la    a0, boot
        call  puts

wait:   lw    t0, 8(s0)
        li    t1, 100
        bge   t0, t1, beat
        la    a0, h2
        call  puts
        mv    a0, t0
        call  putd
        li    t2, 10
        sb    t2, 0(s0)
        li    t2, 2600
        sw    t2, 12(s0)
        j     wait

beat:   li    t2, 1
        sw    t2, 4(s0)
        la    a0, thump
        call  puts
        li    t2, 300
        sw    t2, 12(s0)
        sw    zero, 4(s0)
        sw    zero, 8(s0)
        li    t2, 5000
        sw    t2, 12(s0)
        j     wait

puts:   lbu   t3, 0(a0)
        beqz  t3, done
        sb    t3, 0(s0)
        addi  a0, a0, 1
        j     puts
done:   ret

putd:   li    t4, 10
        div   t5, a0, t4
        rem   t6, a0, t4
        addi  t5, t5, 48
        sb    t5, 0(s0)
        addi  t6, t6, 48
        sb    t6, 0(s0)
        ret

boot:   .asciz "waiting for hydrogen\n"
h2:     .asciz "h2 "
thump:  .asciz "\n  thump\n\n"
