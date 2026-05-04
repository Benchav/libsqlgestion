import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, Index } from 'typeorm';
import { User } from './User';

@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column()
  accessTokenHash!: string;

  @Index({ unique: true })
  @Column()
  refreshTokenHash!: string;

  @Column({ nullable: true })
  revokedAt?: Date | null;

  @Column({ nullable: true })
  expiresAt?: Date | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  user!: User;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
