import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('traffic_metrics')
export class TrafficMetric {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ nullable: true })
  databaseId?: string;

  @Column()
  method!: string;

  @Column()
  path!: string;

  @Column({ type: 'integer', default: 0 })
  requestBytes!: number;

  @Column({ type: 'integer', default: 0 })
  responseBytes!: number;

  @Column({ type: 'integer', default: 0 })
  statusCode!: number;

  @Column({ type: 'integer', default: 0 })
  durationMs!: number;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}
