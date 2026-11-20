import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { Project } from './Project';

@Entity('databases')
export class Database {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Index()
  @Column()
  type!: string; // sqlite | libsql | remote

  @Column({ nullable: true })
  url?: string;

  @Column({ nullable: true })
  encryptedToken?: string;

  @Column({ nullable: true })
  subdomain?: string;

  @Column({ default: 'inactive' })
  status!: 'draft' | 'inactive' | 'provisioning' | 'active' | 'error' | 'disabled';

  // Data-plane protections. Defaults are intentionally false so deploying the
  // migration never changes the behaviour of an existing database.
  @Column({ default: false })
  blockReads!: boolean;

  @Column({ default: false })
  blockWrites!: boolean;

  @Column({ default: false })
  deleteProtection!: boolean;

  @Column({ type: 'simple-json', nullable: true })
  metadata?: Record<string, unknown>;

  @ManyToOne(() => Project)
  project!: Project;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
