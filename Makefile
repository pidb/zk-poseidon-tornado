# Docker 镜像名称
IMAGE_NAME=poseidon-tornado

# 构建 Docker 镜像
build:
	docker build -t $(IMAGE_NAME) .

# 启动容器
start:
	docker run -d --name $(IMAGE_NAME) $(IMAGE_NAME)

# 停止容器
stop:
	docker stop $(IMAGE_NAME)

# 重启容器
restart: stop start

# 删除容器
remove:
	docker rm $(IMAGE_NAME)
