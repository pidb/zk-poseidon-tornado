# Builder 阶段,用于编译 circom
FROM rust:latest as builder

# 安装 Git
RUN apt-get update && apt-get install -y git

# 克隆 circom 仓库
RUN git clone https://github.com/iden3/circom.git

# 进入 circom 目录
WORKDIR /circom

# 编译 circom
RUN cargo build --release

# 运行阶段,用于运行编译后的 circom
FROM node:16


# 设置工作目录
WORKDIR /app

# 创建目录用于存放 circom 二进制文件
RUN mkdir /app/bin

# 从 builder 阶段复制编译好的 circom 二进制文件
COPY --from=builder /circom/target/release/circom /app/bin/


# 安装项目依赖
COPY package.json .

# 复制项目文件
COPY . .


# 设置 PATH 以便使用 circom 命令
ENV PATH="/app/bin:${PATH}"

RUN npm install && npm run build

CMD ["npm", "run", "test"]
