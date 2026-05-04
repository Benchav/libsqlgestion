import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { Database } from './Database';
import { User } from './User';

@Entity('database_migrations')
export class DatabaseMigration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Database, { onDelete: 'CASCADE' })
  database!: Database;

  @Index()
  @Column()
  name!: string;

  @Column({ unique: true })
  checksum!: string;

  @Column({ type: 'simple-json', nullable: true })
  statements?: string[];

  @Column({ nullable: true })
  source!: string;

  @Column({ default: 'applied' })
  status!: 'applied' | 'failed' | 'pending';

  @Column({ nullable: true })
  errorMessage?: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  actor?: User | null;

  @CreateDateColumn()
  appliedAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
