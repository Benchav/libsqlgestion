import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('database_snapshot_policies')
export class DatabaseSnapshotPolicy {
  @PrimaryColumn()
  databaseId!: string;

  @Column({ type: 'integer', default: 60 })
  restorePointIntervalMinutes!: number;

  @Column({ default: true })
  dailyEnabled!: boolean;

  @Column({ type: 'integer', default: 2 })
  dailyAtHour!: number;

  @Column({ type: 'integer', default: 14 })
  dailyRetention!: number;

  @Column({ default: false })
  weeklyEnabled!: boolean;

  @Column({ type: 'integer', default: 0 })
  weeklyDayOfWeek!: number;

  @Column({ type: 'integer', default: 2 })
  weeklyAtHour!: number;

  @Column({ type: 'integer', default: 8 })
  weeklyRetention!: number;

  @Column({ default: false })
  monthlyEnabled!: boolean;

  @Column({ type: 'integer', default: 1 })
  monthlyDayOfMonth!: number;

  @Column({ type: 'integer', default: 2 })
  monthlyAtHour!: number;

  @Column({ type: 'integer', default: 12 })
  monthlyRetention!: number;

  @Column({ default: 'UTC' })
  timezone!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
